import assert from 'node:assert/strict';
import { toSafeTelegramError } from '../src/telegram/telegram-bot';

const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_example';
const error = Object.assign(
  new Error(`POST https://api.telegram.org/bot${token}/getUpdates failed`),
  {
    code: 'EFATAL',
    cause: {
      code: 'ECONNRESET',
    },
    options: {
      url: `https://api.telegram.org/bot${token}/getUpdates`,
      headers: {
        authorization: token,
      },
    },
  },
);

const safeError = toSafeTelegramError(error, token);
const serializedSafeError = JSON.stringify(safeError);

assert.equal(safeError.name, 'Error');
assert.equal(safeError.code, 'EFATAL');
assert.equal(safeError.causeCode, 'ECONNRESET');
assert.match(safeError.message, /\[REDACTED\]/);
assert.doesNotMatch(serializedSafeError, new RegExp(token));
assert.equal('options' in safeError, false);
assert.equal('stack' in safeError, false);

console.log('Telegram error sanitizer tests passed.');
