import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

await mkdir(path.join(process.cwd(), '.tmp'), { recursive: true });
const projectRoot = process.cwd();
const sessionId = 'session_hook_test';

async function isolatedHome(t) {
  const home = await mkdtemp(path.join(projectRoot, '.tmp', 'hooks-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function runHook(relativePath, input, home, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(projectRoot, relativePath)], {
    cwd: projectRoot,
    env: { ...process.env, KIMI_CODE_HOME: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill(), 5_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  return { ...result, stdout, stderr };
}

function failure(message) {
  return {
    hook_event_name: 'StopFailure',
    session_id: sessionId,
    cwd: projectRoot,
    client_type: 'kimi_code_cli',
    error_type: 'APIProviderRateLimitError',
    error_message: message,
  };
}

function pendingPath(home) {
  return path.join(home, 'kimi-code-429-retry', 'sessions', sessionId, 'pending.json');
}

test('StopFailure fails open for malformed JSON without reflecting input', async (t) => {
  const home = await isolatedHome(t);
  const result = await runHook('hooks/stop-failure.mjs', '{private malformed input', home);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('private malformed input'), false);
});

test('StopFailure never schedules exhausted quota or its own recovery process', async (t) => {
  const home = await isolatedHome(t);
  const quota = await runHook('hooks/stop-failure.mjs', JSON.stringify(failure(
    "429 You've reached your monthly usage limit for this billing cycle.",
  )), home);
  assert.equal(quota.code, 0);
  assert.equal(quota.stdout, '');
  await assert.rejects(readFile(pendingPath(home)), { code: 'ENOENT' });

  const recovery = await runHook('hooks/stop-failure.mjs', JSON.stringify(failure(
    "429 We're receiving too many requests at the moment.",
  )), home, { KIMI_CODE_429_RETRY_ACTIVE: '1' });
  assert.equal(recovery.code, 0);
  await assert.rejects(readFile(pendingPath(home)), { code: 'ENOENT' });
});

test('activity hook removes pending recovery and ignores invalid events', async (t) => {
  const home = await isolatedHome(t);
  const filename = pendingPath(home);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify({ token: 'pending', session_id: sessionId }));

  const result = await runHook('hooks/session-activity.mjs', JSON.stringify({
    hook_event_name: 'SessionEnd',
    session_id: sessionId,
    cwd: projectRoot,
    client_type: 'kimi_code_cli',
  }), home);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  await assert.rejects(readFile(filename), { code: 'ENOENT' });

  const invalid = await runHook('hooks/session-activity.mjs', 'not json', home);
  assert.equal(invalid.code, 0);
  assert.equal(invalid.stdout, '');
});

test('worker entry exits cleanly when its pending recovery was cancelled', async (t) => {
  const home = await isolatedHome(t);
  const result = await runHook('hooks/retry-worker.mjs', '', home);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');

  const withArguments = spawn(process.execPath, [
    path.join(projectRoot, 'hooks/retry-worker.mjs'),
    sessionId,
    'cancelled-token',
  ], {
    cwd: projectRoot,
    env: { ...process.env, KIMI_CODE_HOME: home },
    stdio: 'ignore',
  });
  const code = await new Promise((resolve) => withArguments.once('close', resolve));
  assert.equal(code, 0);
});
