import assert from 'node:assert/strict';
import {
  AIAvailabilityGuard,
  classifyAIError,
} from '../src/agent/ai-availability-guard';
import { formatAIParserFailureMessage } from '../src/telegram/telegram-formatters';

/** Builds an error shaped like the OpenAI SDK's APIError. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function testQuotaMessagesNeverAdviseRetyping() {
  const cases = [
    apiError(
      429,
      '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
    ),
    apiError(429, 'You exceeded your current quota, please check your plan and billing details.'),
    apiError(402, 'Insufficient balance'),
  ];

  for (const error of cases) {
    const failure = classifyAIError(error, {});
    assert.equal(failure.category, 'quota', `expected quota for: ${failure.detail}`);
    assert.equal(failure.retryWithSameTextUseful, false);

    const message = formatAIParserFailureMessage(failure.category);
    assert.match(message, /QUOTA/);
    assert.doesNotMatch(message, /chưa đọc rõ/);
    assert.doesNotMatch(message, /gửi lại ngắn gọn/);
  }
}

function testPlainRateLimitIsRetryable() {
  const failure = classifyAIError(apiError(429, 'Rate limit reached for gpt-5.4-mini'), {});
  assert.equal(failure.category, 'rate_limit');

  const message = formatAIParserFailureMessage(failure.category);
  assert.match(message, /giới hạn tần suất/);
}

function testAuthenticationAndConfiguration() {
  assert.equal(
    classifyAIError(apiError(401, 'Incorrect API key provided'), {}).category,
    'authentication',
  );
  assert.equal(
    classifyAIError(
      new Error('Missing OPENAI_API_KEY. AI provider "openai" requires OPENAI_API_KEY.'),
      {},
    ).category,
    'configuration',
  );
  assert.equal(
    classifyAIError(apiError(404, 'model not found'), {}).category,
    'configuration',
  );

  for (const category of ['authentication', 'configuration'] as const) {
    const message = formatAIParserFailureMessage(category);
    assert.match(message, /admin/);
    assert.doesNotMatch(message, /gửi lại ngắn gọn/);
  }
}

function testTransportFailures() {
  assert.equal(
    classifyAIError(new Error('Request timed out.'), {}).category,
    'timeout',
  );
  assert.equal(
    classifyAIError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), {}).category,
    'network',
  );
  assert.equal(
    classifyAIError(apiError(502, 'Bad gateway'), {}).category,
    'provider',
  );
}

function testResponseFormatKeepsTheRewriteHint() {
  const failure = classifyAIError(
    new Error('OpenAI parser returned invalid structured output: empty content'),
    {},
  );
  assert.equal(failure.category, 'response_format');
  assert.equal(failure.retryWithSameTextUseful, true);
  assert.match(formatAIParserFailureMessage(failure.category), /chưa đọc rõ/);

  const refusal = classifyAIError(
    new Error('OpenAI parser refused the request: cannot assist'),
    {},
  );
  assert.equal(refusal.category, 'refusal');
  assert.equal(refusal.retryWithSameTextUseful, true);
}

function testErrorDetailIsSanitized() {
  const failure = classifyAIError(
    new Error('401 Incorrect API key sk-proj-SECRET123456'),
    {},
  );
  assert.doesNotMatch(failure.detail, /SECRET123456/);
  assert.equal(failure.category, 'authentication');
}

function testBreakerOpensOnlyForProviderOutages() {
  let now = 1_000;
  const guard = new AIAvailabilityGuard(() => now, 60_000);
  const quota = classifyAIError(apiError(429, 'You have no credits remaining.'), {});

  guard.recordFailure(quota);
  assert.equal(guard.currentFailure()?.category, 'quota');
  assert.equal(guard.currentFailure()?.category, 'quota', 'repeated checks stay open');

  now += 59_999;
  assert.notEqual(guard.currentFailure(), null, 'still open just before expiry');

  now += 1;
  assert.equal(guard.currentFailure(), null, 'expires after the cooldown');
}

function testBreakerIgnoresRetryableFailuresAndResetsOnSuccess() {
  let now = 0;
  const guard = new AIAvailabilityGuard(() => now, 60_000);

  guard.recordFailure(classifyAIError(apiError(429, 'Rate limit reached'), {}));
  assert.equal(guard.currentFailure(), null, 'a transient rate limit must not block');

  guard.recordFailure(classifyAIError(new Error('no credits remaining'), {}));
  assert.notEqual(guard.currentFailure(), null);

  guard.recordSuccess();
  assert.equal(guard.currentFailure(), null, 'success closes the breaker');
}

function testUnknownErrorsStayActionable() {
  const failure = classifyAIError(new Error('Something odd happened'), {});
  assert.equal(failure.category, 'unreachable');
  assert.match(formatAIParserFailureMessage(failure.category), /AI/);
}

testQuotaMessagesNeverAdviseRetyping();
testPlainRateLimitIsRetryable();
testAuthenticationAndConfiguration();
testTransportFailures();
testResponseFormatKeepsTheRewriteHint();
testErrorDetailIsSanitized();
testBreakerOpensOnlyForProviderOutages();
testBreakerIgnoresRetryableFailuresAndResetsOnSuccess();
testUnknownErrorsStayActionable();

console.log('AI availability guard tests passed.');
