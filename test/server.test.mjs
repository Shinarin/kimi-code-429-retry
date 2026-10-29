import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { launchRecovery, RECOVERY_PROMPT } from '../lib/server.mjs';

await mkdir(path.join(process.cwd(), '.tmp'), { recursive: true });
const sessionId = 'session_server_test';

async function fixture(t, instances = [{ port: 58627 }]) {
  const home = await mkdtemp(path.join(process.cwd(), '.tmp', 'server-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'server', 'instances'), { recursive: true });
  await writeFile(path.join(home, 'server.token'), 'isolated-test-token');
  for (const [index, instance] of instances.entries()) {
    await writeFile(path.join(home, 'server', 'instances', `${index}.json`), JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      started_at: index,
      ...instance,
    }));
  }
  return home;
}

function envelope(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function successfulFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/prompts')) return envelope({ code: 0, data: { accepted: true } });
    return envelope({ code: 0, data: { id: sessionId } });
  };
}

test('discovers one loopback server and submits only the fixed prompt to the original session', async (t) => {
  const home = await fixture(t);
  const calls = [];
  const result = await launchRecovery({ session_id: sessionId, cwd: process.cwd() }, {
    home,
    fetch: successfulFetch(calls),
  });

  assert.equal(result, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `http://127.0.0.1:58627/api/v1/sessions/${sessionId}`);
  assert.equal(calls[1].url, `http://127.0.0.1:58627/api/v1/sessions/${sessionId}/prompts`);
  assert.equal(calls[1].options.method, 'POST');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, { content: [{ type: 'text', text: RECOVERY_PROMPT }] });
  assert.equal('permission_mode' in body, false);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer isolated-test-token');
    assert.equal(call.url.includes('isolated-test-token'), false);
    assert.equal(call.options.body?.includes('isolated-test-token') ?? false, false);
  }
});

test('refuses to choose between multiple matching servers and never submits a prompt', async (t) => {
  const home = await fixture(t, [{ port: 58627 }, { port: 58628 }]);
  const calls = [];
  await assert.rejects(launchRecovery({ session_id: sessionId, cwd: process.cwd() }, {
    home,
    fetch: successfulFetch(calls),
  }), /multiple Kimi servers/i);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.url.endsWith('/prompts')), false);
});

test('never sends the token to a non-loopback override or registry entry', async (t) => {
  const home = await fixture(t, [{ host: '192.168.1.20', port: 58627 }]);
  const calls = [];
  await assert.rejects(launchRecovery({ session_id: sessionId, cwd: process.cwd() }, {
    home,
    env: { KIMI_CODE_429_RETRY_SERVER_URL: 'http://example.com' },
    fetch: successfulFetch(calls),
  }), /loopback/i);
  assert.equal(calls.length, 0);

  await assert.rejects(launchRecovery({ session_id: sessionId, cwd: process.cwd() }, {
    home,
    fetch: successfulFetch(calls),
  }), /no Kimi server/i);
  assert.equal(calls.length, 0);
});

test('uses an explicit loopback server without reading other candidates', async (t) => {
  const home = await fixture(t, [{ port: 58627 }, { port: 58628 }]);
  const calls = [];
  assert.equal(await launchRecovery({ session_id: sessionId, cwd: process.cwd() }, {
    home,
    env: { KIMI_CODE_429_RETRY_SERVER_URL: 'http://127.0.0.1:59000/' },
    fetch: successfulFetch(calls),
  }), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.startsWith('http://127.0.0.1:59000/'), true);
});

test('does not repeat POST when the server rejects the recovery prompt', async (t) => {
  const home = await fixture(t);
  const calls = [];
  await assert.rejects(launchRecovery({ session_id: sessionId, cwd: process.cwd() }, {
    home,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/prompts')) return envelope({ code: 40901, msg: 'rejected' });
      return envelope({ code: 0, data: { id: sessionId } });
    },
  }), /40901/);
  assert.equal(calls.filter((call) => call.url.endsWith('/prompts')).length, 1);
  const stateFiles = await readFile(path.join(home, 'server.token'), 'utf8');
  assert.equal(stateFiles, 'isolated-test-token');
});
