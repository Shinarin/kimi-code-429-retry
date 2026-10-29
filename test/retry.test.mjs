import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DELAY_MS,
  RECOVERY_PROMPT,
  cancelRetry,
  runWorker,
  scheduleRetry,
} from '../lib/retry.mjs';

await mkdir(path.join(process.cwd(), '.tmp'), { recursive: true });
const sessionId = 'session_68840bfa-fbf2-4ca1-bbd1-776f825845f6';

function failure() {
  return {
    hook_event_name: 'StopFailure',
    session_id: sessionId,
    cwd: process.cwd(),
    client_type: 'kimi_code_web',
    error_type: 'APIProviderRateLimitError',
    error_message: "429 We're receiving too many requests at the moment. & not-a-command",
  };
}

async function stateRoot(t) {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp', 'retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function recordPath(root, session, name) {
  return path.join(root, 'sessions', session, `${name}.json`);
}

async function readRecord(root, session, name) {
  return JSON.parse(await readFile(recordPath(root, session, name), 'utf8'));
}

async function putRecord(root, session, name, value) {
  const filename = recordPath(root, session, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}

test('schedules exactly 60 seconds later and cancels before launch', async (t) => {
  const root = await stateRoot(t);
  const workers = [];
  const now = () => 1_000;
  const options = { stateRoot: root,
    confirmFailure: async () => true, now, spawnWorker: (details) => workers.push(details) };

  assert.equal(DEFAULT_DELAY_MS, 60_000);
  assert.equal(await scheduleRetry(failure(), options), true);
  const pending = await readRecord(root, sessionId, 'pending');
  assert.equal(pending.retry_at, 61_000);
  assert.equal(pending.cwd, process.cwd());
  assert.equal(workers.length, 1);
  assert.equal(workers[0].token, pending.token);
  assert.equal('error_message' in workers[0], false);

  let launched = false;
  assert.equal(await cancelRetry(failure(), { stateRoot: root }), true);
  assert.equal(await runWorker(sessionId, pending.token, {
    stateRoot: root,
    confirmFailure: async () => true,
    now,
    launch: async () => { launched = true; },
  }), null);
  assert.equal(launched, false);
});

test('deduplicates pending and running recovery for a session', async (t) => {
  const root = await stateRoot(t);
  let workerCount = 0;
  const options = { stateRoot: root,
    confirmFailure: async () => true, spawnWorker: () => { workerCount += 1; } };

  assert.equal(await scheduleRetry(failure(), options), true);
  assert.equal(await scheduleRetry(failure(), options), false);
  assert.equal(workerCount, 1);

  await cancelRetry(failure(), { stateRoot: root });
  await putRecord(root, sessionId, 'running', { token: 'existing', worker_pid: process.pid });
  assert.equal(await scheduleRetry(failure(), options), false);
  assert.equal(workerCount, 1);
});

test('replaces abandoned pending and running records without launching a stale worker', async (t) => {
  const root = await stateRoot(t);
  const now = Date.now();
  await putRecord(root, sessionId, 'pending', { token: 'abandoned', retry_at: now - 120_000 });
  await putRecord(root, sessionId, 'running', { token: 'dead', worker_pid: -1 });

  let workerCount = 0;
  assert.equal(await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => true,
    now: () => now,
    spawnWorker: () => { workerCount += 1; },
  }), true);
  const pending = await readRecord(root, sessionId, 'pending');
  assert.notEqual(pending.token, 'abandoned');
  assert.equal(workerCount, 1);
  assert.equal(await runWorker(sessionId, 'abandoned', { stateRoot: root,
    confirmFailure: async () => true, launch: async () => 0 }), null);
});

test('worker waits for the stored deadline, owns running state, and launches once', async (t) => {
  const root = await stateRoot(t);
  const now = () => 5_000;
  let token;
  await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => true,
    now,
    spawnWorker: (details) => { token = details.token; },
  });

  let waited;
  let launchCount = 0;
  const result = await runWorker(sessionId, token, {
    stateRoot: root,
    confirmFailure: async () => true,
    now,
    sleep: async (milliseconds) => { waited = milliseconds; },
    launch: async () => {
      launchCount += 1;
      const running = await readRecord(root, sessionId, 'running');
      assert.equal(running.worker_pid, process.pid);
      assert.equal(running.token, token);
      return 0;
    },
  });

  assert.equal(waited, 60_000);
  assert.equal(result, 0);
  assert.equal(launchCount, 1);
  assert.equal((await readRecord(root, sessionId, 'result')).status, 'accepted');
  await assert.rejects(readRecord(root, sessionId, 'running'), { code: 'ENOENT' });
  assert.equal(await runWorker(sessionId, token, { stateRoot: root }), null);
});

test('does not schedule from a marked recovery process or unsafe event data', async (t) => {
  const root = await stateRoot(t);
  let workerCount = 0;
  const options = { stateRoot: root,
    confirmFailure: async () => true, spawnWorker: () => { workerCount += 1; } };

  assert.equal(await scheduleRetry(failure(), {
    ...options,
    env: { KIMI_CODE_429_RETRY_ACTIVE: '1' },
  }), false);
  assert.equal(await scheduleRetry({ ...failure(), session_id: '../../escape' }, options), false);
  assert.equal(await scheduleRetry({ ...failure(), cwd: 'relative/path' }, options), false);
  assert.equal(workerCount, 0);
});

test('allows a short test delay through the environment', async (t) => {
  const root = await stateRoot(t);
  await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => true,
    now: () => 100,
    env: { KIMI_CODE_429_RETRY_DELAY_MS: '25' },
    spawnWorker: () => {},
  });
  assert.equal((await readRecord(root, sessionId, 'pending')).retry_at, 125);
});

test('automatic prompt state prevents recursion and only genuine prompts reset it', async (t) => {
  const root = await stateRoot(t);
  const options = { stateRoot: root,
    confirmFailure: async () => true, spawnWorker: () => {} };
  await cancelRetry({
    ...failure(),
    hook_event_name: 'UserPromptSubmit',
    prompt: RECOVERY_PROMPT,
  }, options);
  assert.equal((await readRecord(root, sessionId, 'result')).status, 'submitting');
  assert.equal(await scheduleRetry(failure(), options), false);

  await cancelRetry({ ...failure(), hook_event_name: 'UserPromptSubmit' }, options);
  assert.equal((await readRecord(root, sessionId, 'result')).status, 'submitting');
  assert.equal(await scheduleRetry(failure(), options), false);

  await cancelRetry({
    ...failure(),
    hook_event_name: 'UserPromptSubmit',
    prompt: 'A genuine new user task',
  }, options);
  await assert.rejects(readRecord(root, sessionId, 'result'), { code: 'ENOENT' });
  assert.equal(await scheduleRetry(failure(), options), true);
  await cancelRetry({ ...failure(), hook_event_name: 'Stop' }, options);
  await assert.rejects(readRecord(root, sessionId, 'pending'), { code: 'ENOENT' });
});

test('worker records failure without error text and permits a later independent failure', async (t) => {
  const root = await stateRoot(t);
  let token;
  await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => true,
    spawnWorker: (details) => { token = details.token; },
  });
  await assert.rejects(runWorker(sessionId, token, {
    stateRoot: root,
    confirmFailure: async () => true,
    sleep: async () => {},
    launch: async () => { throw new Error('sensitive server response'); },
  }), /sensitive server response/);

  const result = await readRecord(root, sessionId, 'result');
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(result).includes('sensitive server response'), false);
  assert.equal(await scheduleRetry(failure(), { stateRoot: root,
    confirmFailure: async () => true, spawnWorker: () => {} }), true);
});

test('late StopFailure after genuine activity does not schedule', async (t) => {
  const root = await stateRoot(t);
  await cancelRetry({
    ...failure(),
    hook_event_name: 'UserPromptSubmit',
    prompt: 'I already retried manually',
  }, { stateRoot: root });
  let workerCount = 0;
  assert.equal(await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => false,
    spawnWorker: () => { workerCount += 1; },
  }), false);
  assert.equal(workerCount, 0);
  await assert.rejects(readRecord(root, sessionId, 'pending'), { code: 'ENOENT' });
});

test('cancellation during current-turn confirmation prevents worker startup', async (t) => {
  const root = await stateRoot(t);
  let workerCount = 0;
  assert.equal(await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => {
      await cancelRetry({
        ...failure(),
        hook_event_name: 'UserPromptSubmit',
        prompt: 'A genuine prompt during confirmation',
      }, { stateRoot: root });
      return true;
    },
    spawnWorker: () => { workerCount += 1; },
  }), false);
  assert.equal(workerCount, 0);
  await assert.rejects(readRecord(root, sessionId, 'pending'), { code: 'ENOENT' });
});

test('uncertain POST outcome stays terminal for the automatic chain', async (t) => {
  const root = await stateRoot(t);
  let token;
  await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => true,
    spawnWorker: (details) => { token = details.token; },
  });
  await cancelRetry({
    ...failure(),
    hook_event_name: 'UserPromptSubmit',
    prompt: RECOVERY_PROMPT,
  }, { stateRoot: root });
  await assert.rejects(runWorker(sessionId, token, {
    stateRoot: root,
    sleep: async () => {},
    launch: async () => {
      const error = new Error('response lost');
      error.recoverySubmissionStarted = true;
      throw error;
    },
  }), /response lost/);

  assert.equal((await readRecord(root, sessionId, 'result')).status, 'unknown');
  assert.equal(await scheduleRetry(failure(), {
    stateRoot: root,
    confirmFailure: async () => true,
    spawnWorker: () => {},
  }), false);
});
