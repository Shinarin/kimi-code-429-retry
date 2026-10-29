import { runWorker } from '../lib/retry.mjs';

try {
  const [sessionId, token] = process.argv.slice(2);
  await runWorker(sessionId, token, {
    stateRoot: process.env.KIMI_CODE_429_RETRY_STATE_ROOT || undefined,
  });
} catch {
  console.error('[kimi-code-429-retry] Recovery worker failed.');
}
