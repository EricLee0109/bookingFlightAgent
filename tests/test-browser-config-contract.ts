import assert from 'node:assert/strict';
import {
  getPlaywrightLaunchOptions,
  resolvePlaywrightDiagnosticsMode,
  resolvePlaywrightHeadlessMode,
  sanitizePlaywrightDiagnosticText,
  sanitizePlaywrightDiagnosticUrl,
  toPlaywrightDiagnosticError,
} from '../src/automation/browser-config';

function runBrowserConfigContractTests() {
  assert.deepEqual(resolvePlaywrightHeadlessMode(undefined, undefined), {
    value: true,
    source: 'default',
    configuredValue: 'not-set',
  });

  assert.deepEqual(resolvePlaywrightHeadlessMode(undefined, ' FALSE '), {
    value: false,
    source: 'environment',
    configuredValue: 'false',
  });

  assert.deepEqual(resolvePlaywrightHeadlessMode(false, 'true'), {
    value: false,
    source: 'override',
    configuredValue: 'false',
  });

  const invalidHeadless = resolvePlaywrightHeadlessMode(undefined, 'headed');
  assert.equal(invalidHeadless.value, true);
  assert.equal(invalidHeadless.source, 'invalid-environment-default');
  assert.match(invalidHeadless.warning ?? '', /must be "true" or "false"/);

  assert.deepEqual(resolvePlaywrightDiagnosticsMode(undefined), {
    value: false,
    source: 'default',
    configuredValue: 'not-set',
  });
  assert.equal(resolvePlaywrightDiagnosticsMode('true').value, true);

  assert.deepEqual(getPlaywrightLaunchOptions(false), {
    headless: false,
    channel: 'chromium',
  });

  assert.equal(
    sanitizePlaywrightDiagnosticUrl(
      'https://user:password@example.com/flights?access_token=secret#details',
    ),
    'https://example.com/flights',
  );
  assert.equal(
    sanitizePlaywrightDiagnosticUrl('data:text/html,password=secret'),
    'data:[REDACTED]',
  );

  const sanitizedText = sanitizePlaywrightDiagnosticText(
    'password=secret "password":"quoted-secret" accessToken: "token-value" Authorization=Bearer abc.def',
  );
  assert.doesNotMatch(
    sanitizedText,
    /secret|quoted-secret|token-value|abc\.def/,
  );
  assert.match(sanitizedText, /\[REDACTED\]/);

  const diagnosticError = toPlaywrightDiagnosticError(
    new Error('password=secret'),
    true,
  );
  assert.equal(diagnosticError.name, 'Error');
  assert.doesNotMatch(diagnosticError.message, /secret/);
  assert.ok('stack' in diagnosticError);

  console.log('Browser config contract tests passed.');
}

runBrowserConfigContractTests();
