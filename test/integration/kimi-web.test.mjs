import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn as spawnPty } from 'node-pty';
import test from 'node:test';

import { RECOVERY_PROMPT } from '../../lib/server.mjs';

const projectRoot = process.cwd();
await mkdir(path.join(projectRoot, '.tmp'), { recursive: true });

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

class InstallerTerminal {
  constructor(command, cwd, env) {
    this.output = '';
    this.cursor = 0;
    this.waiters = new Set();
    this.pty = spawnPty(command, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env,
      useConptyDll: process.platform === 'win32',
    });
    this.exit = new Promise((resolve) => this.pty.onExit(resolve));
    this.pty.onData((data) => {
      this.output += data;
      for (const waiter of this.waiters) waiter();
    });
  }

  write(value) {
    this.pty.write(value);
  }

  async submit(value) {
    this.write(value);
    await sleep(500);
    this.write('\r');
  }

  waitFor(pattern, timeout = 15_000) {
    const find = () => {
      const match = pattern.exec(this.output.slice(this.cursor));
      if (!match) return null;
      this.cursor += match.index + match[0].length;
      return match[0];
    };
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Terminal did not produce ${pattern}`));
      }, timeout);
      const check = () => {
        const match = find();
        if (!match) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(match);
      };
      this.waiters.add(check);
    });
  }

  async close() {
    this.write('\x1b');
    await sleep(150);
    await this.submit('/exit');
    await Promise.race([this.exit, sleep(5_000)]);
    this.pty.kill();
    if (process.platform === 'win32') {
      // node-pty 在 ConPTY 自然退出后可能保留 conout worker，测试结束时需显式释放。
      this.pty._agent._conoutSocketWorker.dispose();
      this.pty._agent.inSocket.destroy();
      this.pty._agent.outSocket.destroy();
    }
  }
}

function textContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part.text || '').join('\n');
  return '';
}

async function startMockModel() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      const lastUser = [...parsed.messages].reverse().find((message) => message.role === 'user');
      const prompt = textContent(lastUser);
      const isRateLimit = prompt.trim() === 'SECOND_TURN_TRIGGER_429';
      const isRecovery = prompt.includes(RECOVERY_PROMPT);
      requests.push({ isRateLimit, isRecovery });
      if (isRateLimit) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: {
          message: "We're receiving too many requests at the moment. Please wait a moment and try again.",
          type: 'rate_limit_error',
        } }));
        return;
      }
      const content = isRecovery ? 'recovered-mock-response' : 'first-mock-response';
      if (parsed.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
          'data: [DONE]',
        ].join('\n\n') + '\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function copyInstallSource(root) {
  const source = path.join(root, 'source');
  await mkdir(source, { recursive: true });
  for (const name of ['kimi.plugin.json', 'README.md', 'LICENSE', 'package.json']) {
    await cp(path.join(projectRoot, name), path.join(source, name));
  }
  for (const name of ['hooks', 'lib']) {
    await cp(path.join(projectRoot, name), path.join(source, name), { recursive: true });
  }
  return source;
}

async function stopProcess(child, exited) {
  if (exited()) return;
  child.kill();
  if (!exited()) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (!exited() && process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  }
}

test('real plugin recovers the original session through the loopback Server API', {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(path.join(projectRoot, '.tmp', 'kimi-web-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  const source = await copyInstallSource(root);
  const model = await startMockModel();
  await writeFile(path.join(home, 'config.toml'), `default_model = "test/mock"
default_permission_mode = "manual"
telemetry = false
[providers.test]
type = "openai"
base_url = "http://127.0.0.1:${model.port}/v1"
api_key = "dummy"
[models."test/mock"]
provider = "test"
model = "mock"
max_context_size = 8192
capabilities = ["tool_use"]
[loop_control]
max_attempts_per_step = 1
compaction_max_attempts = 1
`);

  const env = {
    ...process.env,
    KIMI_CODE_HOME: home,
    KIMI_CODE_429_RETRY_DELAY_MS: '250',
  };
  const cli = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE, '.kimi-code', 'bin', 'kimi.exe')
    : 'kimi';
  let terminal;
  let web;
  let webExited = false;
  try {
    terminal = new InstallerTerminal(cli, work, env);
    const firstScreen = await terminal.waitFor(/Trust this folder\?|Welcome to Kimi Code!/);
    if (firstScreen.startsWith('Trust')) {
      terminal.write('\r');
      const nextScreen = await terminal.waitFor(/Migrate from kimi-cli|Welcome to Kimi Code!/);
      if (nextScreen.startsWith('Migrate')) {
        terminal.write('\x1b');
        await terminal.waitFor(/Welcome to Kimi Code!/);
      }
    }
    await terminal.submit(`/plugins install ${source}`);
    await terminal.waitFor(/Install third-party plugin/);
    terminal.write('\x1b[B');
    await terminal.waitFor(/❯ Trust and install/);
    terminal.write('\r');
    await terminal.waitFor(/Install finished/);
    await terminal.submit('/plugins info kimi-code-429-retry');
    await terminal.waitFor(/Status: enabled \| state: ok/);
    await terminal.close();
    terminal = null;

    const port = await availablePort();
    web = spawn(cli, ['web', '--no-open', '--port', String(port)], {
      cwd: work,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    web.stdout.resume();
    web.stderr.resume();
    web.once('exit', () => { webExited = true; });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/api/v1/healthz`)).ok;
      } catch {
        return false;
      }
    }, 'the isolated Kimi Web server');
    const token = (await readFile(path.join(home, 'server.token'), 'utf8')).trim();
    async function api(pathname, options = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...options.headers,
        },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json();
      assert.equal(response.ok, true);
      assert.equal(body.code, 0);
      return body.data;
    }

    const created = await api('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ metadata: { cwd: work } }),
    });
    const sessionId = created.id;
    assert.match(sessionId, /^session_[A-Za-z0-9_-]+$/);
    await api(`/api/v1/sessions/${sessionId}/profile`, {
      method: 'POST',
      body: JSON.stringify({ agent_config: { model: 'test/mock', permission_mode: 'manual' } }),
    });
    async function submit(text) {
      await api(`/api/v1/sessions/${sessionId}/prompts`, {
        method: 'POST',
        body: JSON.stringify({ content: [{ type: 'text', text }] }),
      });
    }
    async function historyContains(text) {
      const history = await api(`/api/v1/sessions/${sessionId}/messages?page_size=100`);
      return JSON.stringify(history).includes(text);
    }

    await submit('FIRST_TURN_OK');
    await waitFor(() => historyContains('first-mock-response'), 'the first mock response');
    await submit('SECOND_TURN_TRIGGER_429');
    await waitFor(() => model.requests.some((request) => request.isRateLimit), 'the simulated 429');
    await waitFor(() => model.requests.some((request) => request.isRecovery), 'the automatic recovery prompt');
    await waitFor(() => historyContains('recovered-mock-response'), 'recovery in the original session history');

    assert.equal(model.requests.filter((request) => request.isRateLimit).length, 1);
    assert.equal(model.requests.filter((request) => request.isRecovery).length, 1);
    assert.equal(await historyContains(RECOVERY_PROMPT), true);
    assert.equal(await historyContains('SECOND_TURN_TRIGGER_429'), true);
  } catch (error) {
    if (terminal) await writeFile(path.join(root, 'installer-terminal.log'), terminal.output);
    throw error;
  } finally {
    if (terminal) await terminal.close();
    if (web) await stopProcess(web, () => webExited);
    await model.close();
  }
});
