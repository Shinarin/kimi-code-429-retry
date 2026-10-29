import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldRetry } from './rate-limit.mjs';

export const DEFAULT_DELAY_MS = 60_000;
export const RECOVERY_PROMPT = 'The previous turn ended after a transient HTTP 429 rate limit. Continue the interrupted task using the existing session context. Check prior tool results before repeating any side effects.';

const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STALE_GRACE_MS = 60_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function defaultStateRoot(env) {
  const home = env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'kimi-code-429-retry');
}

function stateRootFrom(options) {
  return options.stateRoot || defaultStateRoot(options.env || process.env);
}

function statePaths(root, sessionId) {
  const directory = path.join(root, 'sessions', sessionId);
  return {
    directory,
    pending: path.join(directory, 'pending.json'),
    running: path.join(directory, 'running.json'),
  };
}

function delayFrom(options, env) {
  const value = options.delayMs ?? env.KIMI_CODE_429_RETRY_DELAY_MS;
  if (value === undefined || value === '') return DEFAULT_DELAY_MS;
  const delay = Number(value);
  return Number.isSafeInteger(delay) && delay >= 0 && delay <= 2_147_483_647
    ? delay
    : DEFAULT_DELAY_MS;
}

async function readRecord(filename) {
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function removeRecord(filename, token) {
  if (token !== undefined) {
    const record = await readRecord(filename);
    if (record?.token !== token) return false;
  }
  try {
    await unlink(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function runningIsActive(record, now) {
  if (!record) return false;
  if (Number.isInteger(record.worker_pid) && record.worker_pid > 0) {
    return processIsAlive(record.worker_pid);
  }
  const timestamp = record.claimed_at ?? record.created_at;
  return Number.isFinite(timestamp) && now - timestamp <= STALE_GRACE_MS;
}

function pendingIsActive(record, now) {
  return record !== null
    && typeof record.token === 'string'
    && Number.isFinite(record.retry_at)
    && now <= record.retry_at + STALE_GRACE_MS;
}

async function writeRecord(filename, record) {
  const temporary = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx' });
  try {
    await rename(temporary, filename);
  } finally {
    await removeRecord(temporary);
  }
}

async function createPending(paths, record) {
  const temporary = path.join(paths.directory, `.${record.token}.tmp`);
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx' });
  try {
    await link(temporary, paths.pending);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await removeRecord(temporary);
  }
}

async function spawnWorker({ sessionId, token, stateRoot }) {
  const worker = path.join(PLUGIN_ROOT, 'hooks', 'retry-worker.mjs');
  const child = spawn(process.execPath, [worker, sessionId, token], {
    cwd: PLUGIN_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, KIMI_CODE_429_RETRY_STATE_ROOT: stateRoot },
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}

export async function scheduleRetry(payload, options = {}) {
  const env = options.env || process.env;
  if (env.KIMI_CODE_429_RETRY_ACTIVE === '1'
    || !shouldRetry(payload)
    || !validSessionId(payload.session_id)
    || typeof payload.cwd !== 'string'
    || !path.isAbsolute(payload.cwd)) {
    return false;
  }

  const stateRoot = stateRootFrom(options);
  const now = options.now || Date.now;
  const timestamp = now();
  const paths = statePaths(stateRoot, payload.session_id);
  const running = await readRecord(paths.running);
  if (runningIsActive(running, timestamp)) return false;
  if (running) await removeRecord(paths.running);

  const pending = await readRecord(paths.pending);
  if (pendingIsActive(pending, timestamp)) return false;
  if (pending) await removeRecord(paths.pending);

  await mkdir(paths.directory, { recursive: true });
  const record = {
    version: 1,
    token: randomUUID(),
    session_id: payload.session_id,
    cwd: payload.cwd,
    created_at: timestamp,
    retry_at: timestamp + delayFrom(options, env),
  };
  const created = await createPending(paths, record);
  if (!created) return false;

  try {
    await (options.spawnWorker || spawnWorker)({
      sessionId: payload.session_id,
      token: record.token,
      stateRoot,
    });
  } catch (error) {
    await removeRecord(paths.pending, record.token);
    throw error;
  }
  return true;
}

export async function cancelRetry(payload, options = {}) {
  if (!payload || !validSessionId(payload.session_id)) return false;
  const paths = statePaths(stateRootFrom(options), payload.session_id);
  return removeRecord(paths.pending);
}

export async function runWorker(sessionId, token, options = {}) {
  if (!validSessionId(sessionId) || typeof token !== 'string') return null;
  const paths = statePaths(stateRootFrom(options), sessionId);
  const now = options.now || Date.now;
  const pending = await readRecord(paths.pending);
  if (!pending || pending.token !== token || pending.session_id !== sessionId) return null;

  const wait = Math.max(0, pending.retry_at - now());
  if (wait > 0) await (options.sleep || ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  })))(wait);

  const existing = await readRecord(paths.running);
  if (runningIsActive(existing, now())) {
    await removeRecord(paths.pending, token);
    return null;
  }
  if (existing) await removeRecord(paths.running);

  try {
    await rename(paths.pending, paths.running);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const claimed = await readRecord(paths.running);
  if (!claimed || claimed.token !== token || claimed.session_id !== sessionId) {
    await rename(paths.running, paths.pending).catch(() => {});
    return null;
  }
  claimed.worker_pid = process.pid;
  claimed.claimed_at = now();
  await writeRecord(paths.running, claimed);

  try {
    return await (options.launch || launchRecovery)(claimed, {
      ...options,
      env: options.env || process.env,
    });
  } finally {
    await removeRecord(paths.running, token);
  }
}

export async function resolveCli(env = process.env, platform = process.platform) {
  const override = env.KIMI_CODE_429_RETRY_CLI?.trim();
  if (override) return override;
  if (platform !== 'win32') return 'kimi';

  const directories = (env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const directory of directories) {
    for (const name of ['kimi.exe', 'kimi.cmd', 'kimi.bat', 'kimi']) {
      const candidate = path.join(directory, name);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
      }
    }
  }
  return 'kimi';
}

export async function launchRecovery(record, options = {}) {
  if (!validSessionId(record.session_id) || !path.isAbsolute(record.cwd)) {
    throw new TypeError('Invalid recovery session or working directory');
  }
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const command = options.cliPath || await resolveCli(env, platform);
  const child = (options.spawnProcess || spawn)(command, [
    '--session',
    record.session_id,
    '--prompt',
    RECOVERY_PROMPT,
  ], {
    cwd: record.cwd,
    env: { ...env, KIMI_CODE_429_RETRY_ACTIVE: '1' },
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}
