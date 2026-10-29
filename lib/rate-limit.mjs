const TRANSIENT_MESSAGES = [
  "we're receiving too many requests",
  'the engine is currently overloaded',
];
const PERMANENT_MESSAGES = [
  "you've reached your 5-hour usage limit",
  "you've reached your weekly (7-day) usage limit",
  "you've reached your monthly usage limit for this billing cycle",
  'your credit balance is insufficient',
  "your organization's extra usage balance has run out",
  "you've reached the extra usage limit set for your account by your organization",
  "you've reached your concurrent request limit",
];

export function shouldRetry(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  if (payload.error_type !== 'APIProviderRateLimitError' || typeof payload.error_message !== 'string') {
    return false;
  }

  const message = payload.error_message.toLowerCase();
  if (PERMANENT_MESSAGES.some((permanentMessage) => message.includes(permanentMessage))) {
    return false;
  }
  return /\b429\b/.test(message)
    && TRANSIENT_MESSAGES.some((transientMessage) => message.includes(transientMessage));
}
