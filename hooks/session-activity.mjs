import { readHookPayload } from '../lib/hook-input.mjs';
import { cancelRetry } from '../lib/retry.mjs';

try {
  const payload = await readHookPayload();
  await cancelRetry(payload);
} catch {
  console.error('[kimi-code-429-retry] Session activity was not processed.');
}
