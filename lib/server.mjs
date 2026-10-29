import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const RECOVERY_PROMPT = 'This is one automatic retry from kimi-code-429-retry after a transient HTTP 429. Continue the interrupted task using the existing session context. Check prior tool results before repeating any side effects.';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function explicitLoopback(value) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    && url.pathname === '/'
    && url.search === ''
    && url.hash === ''
    && url.username === ''
    && url.password === '';
  if (!loopback) throw new Error('Kimi recovery server URL must be a loopback HTTP origin');
  return url.origin;
}

function registryLoopback(record) {
  if (!processIsAlive(record.pid) || !Number.isInteger(record.port)
    || record.port < 1 || record.port > 65_535) {
    return null;
  }
  if (['127.0.0.1', 'localhost', '0.0.0.0'].includes(record.host)) {
    return `http://127.0.0.1:${record.port}`;
  }
  if (['::', '[::]', '::1', '[::1]'].includes(record.host)) {
    return `http://[::1]:${record.port}`;
  }
  return null;
}

async function registryCandidates(home) {
  const directory = path.join(home, 'server', 'instances');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      try {
        const record = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'));
        return registryLoopback(record);
      } catch {
        return null;
      }
    }));
  return [...new Set(candidates.filter(Boolean))];
}

async function requestJson(fetchImpl, url, token, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeout || 5_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Kimi server returned HTTP ${response.status}`);
  return body;
}

async function discoverServer(sessionId, home, env, token, fetchImpl, explicitUrl) {
  const candidates = explicitUrl
    ? [explicitLoopback(explicitUrl)]
    : await registryCandidates(home);
  const matches = await Promise.all(candidates.map(async (baseUrl) => {
    try {
      const body = await requestJson(
        fetchImpl,
        `${baseUrl}/api/v1/sessions/${sessionId}`,
        token,
        { timeout: 1_000 },
      );
      return body.code === 0 && body.data?.id === sessionId ? baseUrl : null;
    } catch {
      return null;
    }
  }));
  const found = matches.filter(Boolean);
  if (found.length > 1) throw new Error('Multiple Kimi servers contain this session');
  if (found.length === 0) throw new Error('No Kimi server contains this session');
  return found[0];
}

export async function launchRecovery(record, options = {}) {
  if (typeof record.session_id !== 'string' || !SESSION_ID_PATTERN.test(record.session_id)
    || typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd)) {
    throw new TypeError('Invalid recovery session or working directory');
  }
  const env = options.env || process.env;
  const home = options.home || env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  const token = options.token || (await readFile(path.join(home, 'server.token'), 'utf8')).trim();
  if (!token) throw new Error('Kimi server token is empty');
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseUrl = await discoverServer(
    record.session_id,
    home,
    env,
    token,
    fetchImpl,
    options.serverUrl || env.KIMI_CODE_429_RETRY_SERVER_URL,
  );
  const result = await requestJson(fetchImpl, `${baseUrl}/api/v1/sessions/${record.session_id}/prompts`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: [{ type: 'text', text: RECOVERY_PROMPT }] }),
  });
  if (result.code !== 0) throw new Error(`Kimi recovery prompt rejected with code ${result.code}`);
  return 0;
}
