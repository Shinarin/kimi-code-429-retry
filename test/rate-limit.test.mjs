import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRetry } from '../lib/rate-limit.mjs';

function failure(errorMessage, errorType = 'APIProviderRateLimitError') {
  return {
    hook_event_name: 'StopFailure',
    session_id: 'session_68840bfa-fbf2-4ca1-bbd1-776f825845f6',
    cwd: 'D:\\work\\project',
    client_type: 'kimi_code_cli',
    error_type: errorType,
    error_message: errorMessage,
  };
}

test('retries only the documented transient 429 failures', async (t) => {
  const messages = [
    "429 We're receiving too many requests at the moment. Please wait a moment and try again.",
    'error, status code: 429, message: The engine is currently overloaded, please try again later',
  ];

  for (const message of messages) {
    await t.test(message, () => {
      assert.equal(shouldRetry(failure(message)), true);
    });
  }
});

test('never retries exhausted quotas, balances, or organization limits', async (t) => {
  const messages = [
    "429 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
    "429 You've reached your weekly (7-day) usage limit.",
    '429 You\'ve reached your monthly usage limit for this billing cycle.',
    '429 Your credit balance is insufficient.',
    "429 Your organization's Extra Usage balance has run out.",
    "429 You've reached the Extra Usage limit set for your account by your organization.",
  ];

  for (const message of messages) {
    await t.test(message, () => {
      assert.equal(shouldRetry(failure(message)), false);
    });
  }
});

test('does not guess that other 429 failures are temporary', async (t) => {
  const messages = [
    "429 You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
    '429 rate limit reached',
  ];

  for (const message of messages) {
    await t.test(message, () => {
      assert.equal(shouldRetry(failure(message)), false);
    });
  }
});

test('requires a transient message, a 429 status, and the provider rate-limit error type', () => {
  assert.equal(shouldRetry(failure("We're receiving too many requests at the moment.")), false);
  assert.equal(shouldRetry(failure("4290 We're receiving too many requests at the moment.")), false);
  assert.equal(shouldRetry(failure("401 We're receiving too many requests at the moment.")), false);
  assert.equal(shouldRetry(failure("429 We're receiving too many requests at the moment.", 'APIProviderAuthenticationError')), false);
});

test('fails closed for missing or malformed payloads', () => {
  const invalid = [null, undefined, '', {}, [], 429, failure(null), failure(undefined)];
  for (const payload of invalid) {
    assert.equal(shouldRetry(payload), false);
  }
});
