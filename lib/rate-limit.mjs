const TRANSIENT_MESSAGES = [
  "we're receiving too many requests",
  'the engine is currently overloaded',
];

export function shouldRetry(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  if (payload.error_type !== 'APIProviderRateLimitError' || typeof payload.error_message !== 'string') {
    return false;
  }

  const message = payload.error_message.toLowerCase();
  return /\b429\b/.test(message)
    && TRANSIENT_MESSAGES.some((transientMessage) => message.includes(transientMessage));
}
