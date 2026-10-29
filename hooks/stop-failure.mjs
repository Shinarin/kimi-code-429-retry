import { readHookPayload } from '../lib/hook-input.mjs';
import { scheduleRetry } from '../lib/retry.mjs';

try {
  const payload = await readHookPayload();
  await scheduleRetry(payload);
} catch {
  console.error('[kimi-code-429-retry] StopFailure event was not processed.');
}
