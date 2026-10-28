import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Exercise the real startup registration with offline transport and business handlers.
const Module = require('node:module');
const originalLoad = Module._load;
const originalError = console.error;
const originalLog = console.log;
const previousToken = process.env.TELEGRAM_BOT_TOKEN;
const previousMode = process.env.AGENT_ORCHESTRATION_MODE;
const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_synthetic';
const escaped: unknown[] = [];
const logged: unknown[][] = [];
const calls = { message: 0, callback: 0, notifications: 0 };
let failHandler = true;
let failNotification = true;
let bot: FakeBot;

function connectionError() {
  return Object.assign(new Error(`EFATAL: read ECONNRESET https://api.telegram.org/bot${token}/sendMessage`), {
    code: 'EFATAL', cause: { code: 'ECONNRESET' },
  });
}

class FakeBot extends EventEmitter {
  constructor() { super(); bot = this; }
  sendMessage() {
    calls.notifications += 1;
    return failNotification ? Promise.reject(connectionError()) : Promise.resolve({});
  }
}

const collectRejection = (error: unknown) => escaped.push(error);
const settleEvents = () => new Promise(resolve => setTimeout(resolve, 30));

async function main() {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.AGENT_ORCHESTRATION_MODE = 'legacy';
  console.error = (...args: unknown[]) => { logged.push(args); };
  console.log = () => {};
  process.on('unhandledRejection', collectRejection);
  Module._load = function (id: string, parent: unknown, isMain: boolean) {
    if (id === 'node-telegram-bot-api') return FakeBot;
    if (id === './telegram-message-handler') return {
      handleTelegramMessage: async () => {
        calls.message += 1;
        if (failHandler) throw connectionError();
      },
    };
    if (id === './telegram-passenger-message-handler') return {
      handleTelegramCallbackQuery: async () => {
        calls.callback += 1;
        if (failHandler) throw connectionError();
      },
    };
    return originalLoad.call(this, id, parent, isMain);
  };

  try {
    const { startTelegramAgent } = require('../src/telegram/telegram-bot');
    await startTelegramAgent();
    const message = { chat: { id: 101 } };
    const callback = { message };
    bot!.emit('message', message);
    bot!.emit('callback_query', callback);
    await settleEvents();
    assert.equal(escaped.length, 0, 'double failures must not escape either async event listener');
    assert.deepEqual(calls, { message: 1, callback: 1, notifications: 2 }, 'failed business actions are not replayed');
    assert.equal(logged.length, 4, 'both original errors and notification failures are logged');
    const labels = logged.map(entry => String(entry[0]));
    assert.equal(new Set(labels).size, 4, 'primary and secondary message/callback failures are distinguishable');
    for (const entry of logged) {
      const error = entry[1] as { code: string; causeCode: string; message: string };
      assert.equal(error.code, 'EFATAL');
      assert.equal(error.causeCode, 'ECONNRESET');
      assert.match(error.message, /\[REDACTED\]/);
      assert.ok(!JSON.stringify(entry).includes(token), 'logs must not expose the bot token');
    }

    failNotification = false;
    bot!.emit('message', message);
    bot!.emit('callback_query', callback);
    await settleEvents();
    assert.deepEqual(calls, { message: 2, callback: 2, notifications: 4 });
    assert.equal(escaped.length, 0, 'successful fallback notifications settle');

    failHandler = false;
    bot!.emit('message', message);
    bot!.emit('callback_query', callback);
    await settleEvents();
    assert.deepEqual(calls, { message: 3, callback: 3, notifications: 4 }, 'later events still execute once');

    failHandler = true;
    bot!.emit('message', {});
    bot!.emit('callback_query', {});
    bot!.emit('polling_error', connectionError());
    bot!.emit('error', connectionError());
    await settleEvents();
    assert.equal(calls.notifications, 4, 'no notification without a chat');
    assert.equal(escaped.length, 0);
    assert.ok(logged.some(entry => entry[0] === 'Telegram long polling error:'));
    assert.ok(logged.some(entry => entry[0] === 'Telegram bot runtime error:'));
  } finally {
    Module._load = originalLoad;
    console.error = originalError;
    console.log = originalLog;
    process.removeListener('unhandledRejection', collectRejection);
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE;
    else process.env.AGENT_ORCHESTRATION_MODE = previousMode;
  }
  console.log('Telegram runtime error tests passed: double failures, recovery, no replay, sanitized logs and polling listeners. No network calls.');
}

main().catch(error => { originalError(error); process.exitCode = 1; });
