import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type SentRecord = {
  kind: 'message' | 'photo' | 'answer';
  chatId?: number;
  text?: string;
  path?: string;
  options?: Record<string, unknown>;
};

/** Minimal Telegram transport double; no Telegram network methods are used. */
class FakeBot {
  readonly sent: SentRecord[] = [];

  async sendMessage(
    chatId: number,
    text: string,
    options?: Record<string, unknown>,
  ) {
    this.sent.push({ kind: 'message', chatId, text, options });
    return {};
  }

  async sendPhoto(
    chatId: number,
    photoPath: string,
    options?: Record<string, unknown>,
  ) {
    this.sent.push({ kind: 'photo', chatId, path: photoPath, options });
    return {};
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    options?: Record<string, unknown>,
  ) {
    this.sent.push({ kind: 'answer', text: callbackQueryId, options });
    return true;
  }
}

function telegramMessage(text: string, userId = 42, chatId = 700, messageId = 1) {
  return {
    message_id: messageId,
    chat: { id: chatId, type: 'private' },
    from: { id: userId, is_bot: false, first_name: 'QA' },
    text,
  } as never;
}

function telegramCallback(data: string, userId = 42, chatId = 700, id = 'callback-1') {
  return {
    id,
    from: { id: userId, is_bot: false, first_name: 'QA' },
    message: {
      message_id: 900,
      chat: { id: chatId, type: 'private' },
    },
    data,
  } as never;
}

function pilotSettings() {
  return {
    agentEnabled: true,
    autoSearchFlights: true,
    autoHoldBooking: false,
    requireConfirmationBeforeHold: true,
    debugMode: false,
  };
}

function searchedTurnResult() {
  return {
    ok: true,
    status: 'searched',
    response: 'Mình đã tìm thấy các chuyến phù hợp.',
    message: 'Mình đã tìm thấy các chuyến phù hợp.',
    screenshotPaths: ['screenshots/hybrid-telegram-1.png'],
    screenshotBatches: [{
      path: 'screenshots/hybrid-telegram-1.png',
      candidateIds: ['candidate-1'],
    }],
    capturedAt: '2026-09-14T03:04:05.000Z',
    snapshotId: 'FS-telegram-test',
    liveSearchPerformed: true,
  };
}

async function runChild() {
  const {
    handleTelegramMessage,
  } = await import('../src/telegram/telegram-message-handler');
  const {
    handleTelegramHybridSearchMessage,
  } = await import('../src/telegram/telegram-hybrid-search');
  const {
    handleTelegramCallbackQuery,
  } = await import('../src/telegram/telegram-passenger-message-handler');

  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  process.env.TELEGRAM_OPERATOR_IDS = '42';

  // An unauthorized hybrid message is rejected before the injected runner.
  const unauthorizedBot = new FakeBot();
  let unauthorizedRunnerCalls = 0;
  const unauthorizedHandled = await handleTelegramHybridSearchMessage(
    unauthorizedBot as never,
    telegramMessage('Tìm chuyến SGN đi HAN', 99, 701, 1),
    {
      runTurn: async () => {
        unauthorizedRunnerCalls += 1;
        return searchedTurnResult() as never;
      },
      settingsReader: async () => pilotSettings(),
    },
  );
  assert.equal(unauthorizedHandled, true);
  assert.equal(unauthorizedRunnerCalls, 0);
  assert.equal(unauthorizedBot.sent.filter((item) => item.kind === 'message').length, 1);
  assert.match(unauthorizedBot.sent[0].text ?? '', /chưa có quyền/i);

  // Settings remain application-owned commands and bypass the pilot runner.
  const settingsBot = new FakeBot();
  await handleTelegramMessage(settingsBot as never, telegramMessage('/agent_off', 42, 702, 2));
  await handleTelegramMessage(settingsBot as never, telegramMessage('/settings', 42, 702, 3));
  assert.match(settingsBot.sent.at(-1)?.text ?? '', /agentEnabled: false/);
  await handleTelegramMessage(settingsBot as never, telegramMessage('/agent_on', 42, 702, 4));
  await handleTelegramMessage(settingsBot as never, telegramMessage('/auto_search_off', 42, 702, 5));
  await handleTelegramMessage(settingsBot as never, telegramMessage('/settings', 42, 702, 6));
  assert.match(settingsBot.sent.at(-1)?.text ?? '', /agentEnabled: true/);
  assert.match(settingsBot.sent.at(-1)?.text ?? '', /autoSearchFlights: false/);

  // The full message entrypoint intercepts legacy hold/recovery/passenger
  // traffic before those handlers can inspect a case or call automation.
  const routingBot = new FakeBot();
  await handleTelegramMessage(
    routingBot as never,
    telegramMessage('/hold BK-20260914-010203', 42, 703, 7),
  );
  assert.match(routingBot.sent.at(-1)?.text ?? '', /chưa hỗ trợ giữ chỗ/i);
  assert.equal(routingBot.sent.at(-1)?.options?.reply_markup, undefined);

  await handleTelegramMessage(routingBot as never, telegramMessage('/agent_off', 42, 703, 8));
  const beforeBlockedNatural = routingBot.sent.length;
  await handleTelegramMessage(
    routingBot as never,
    telegramMessage('NGUYEN VAN A 01/01/1990', 42, 703, 9),
  );
  await handleTelegramMessage(
    routingBot as never,
    telegramMessage('recover BK-20260914-010203 PNR HXGUQ9', 42, 703, 10),
  );
  const blockedMessages = routingBot.sent
    .slice(beforeBlockedNatural)
    .filter((item) => item.kind === 'message')
    .map((item) => item.text ?? '');
  assert.equal(blockedMessages.length, 2);
  assert.ok(blockedMessages.every((text) => /Agent hiện đang tắt/i.test(text)));

  // Every pre-existing callback family is blocked after callback acknowledgement.
  const callbackBot = new FakeBot();
  for (const [index, data] of [
    'hold_approval:BK-20260914-010203',
    'passenger_choose:BK-20260914-010203:1',
    'pnr_detail:BK-20260914-010203',
  ].entries()) {
    await handleTelegramCallbackQuery(
      callbackBot as never,
      telegramCallback(data, 42, 704, `callback-${index}`),
    );
  }
  assert.equal(callbackBot.sent.filter((item) => item.kind === 'answer').length, 3);
  const callbackMessages = callbackBot.sent.filter((item) => item.kind === 'message');
  assert.equal(callbackMessages.length, 3);
  assert.ok(callbackMessages.every((item) => /chỉ hỗ trợ tìm và so sánh/i.test(item.text ?? '')));
  assert.ok(callbackMessages.every((item) => item.options?.reply_markup === undefined));

  // The injectable runner lets transport tests exercise screenshot delivery
  // without an OpenAI call, browser, or real Telegram bot.
  const screenshotBot = new FakeBot();
  let receivedRunnerOptions: Record<string, unknown> | undefined;
  const screenshotHandled = await handleTelegramHybridSearchMessage(
    screenshotBot as never,
    telegramMessage('Tìm chuyến SGN đi HAN ngày 21/09', 42, 705, 11),
    {
      settingsReader: async () => pilotSettings(),
      runTurn: async (_chatId, _text, options) => {
        receivedRunnerOptions = options as unknown as Record<string, unknown>;
        await options?.onProcessingStarted?.();
        return searchedTurnResult() as never;
      },
    },
  );
  assert.equal(screenshotHandled, true);
  assert.equal(receivedRunnerOptions?.ownerTelegramUserId, 42);
  assert.equal(receivedRunnerOptions?.messageId, 11);
  const screenshotMessage = screenshotBot.sent.find((item) => item.kind === 'message');
  const screenshot = screenshotBot.sent.find((item) => item.kind === 'photo');
  assert.equal(screenshotMessage?.options?.reply_markup, undefined);
  assert.equal(screenshot?.path, 'screenshots/hybrid-telegram-1.png');
  assert.match(screenshot?.options?.caption as string, /Ảnh lịch trình 1\/1/);
  assert.match(screenshot?.options?.caption as string, /chỉ gồm chuyến trong danh sách đã lọc/);
  assert.doesNotMatch(screenshot?.options?.caption as string, /các chuyến khác/);
  assert.match(screenshot?.options?.caption as string, /FS-telegram-test/);
  assert.match(screenshot?.options?.caption as string, /2026-09-14T03:04:05\.000Z/);
  assert.equal(screenshot?.options?.reply_markup, undefined);

  // A duplicate result from the durable turn seam must not send a second
  // customer-facing message or screenshot.
  const duplicateBot = new FakeBot();
  let duplicateRunnerCalls = 0;
  const duplicateRunner = async (_chatId: number, _text: string, options?: { onProcessingStarted?: () => void | Promise<void> }) => {
    duplicateRunnerCalls += 1;
    if (duplicateRunnerCalls === 1) await options?.onProcessingStarted?.();
    return duplicateRunnerCalls === 1
      ? searchedTurnResult()
      : {
          ...searchedTurnResult(),
          status: 'duplicate',
          ok: false,
          response: '',
          message: '',
          screenshotPaths: [],
          screenshotBatches: [],
          duplicate: true,
          liveSearchPerformed: false,
        };
  };
  const duplicateMessage = telegramMessage('Tìm chuyến lặp lại', 42, 706, 12);
  await handleTelegramHybridSearchMessage(duplicateBot as never, duplicateMessage, {
    settingsReader: async () => pilotSettings(),
    runTurn: duplicateRunner as never,
  });
  const sendsAfterFirst = duplicateBot.sent.length;
  await handleTelegramHybridSearchMessage(duplicateBot as never, duplicateMessage, {
    settingsReader: async () => pilotSettings(),
    runTurn: duplicateRunner as never,
  });
  assert.equal(duplicateRunnerCalls, 2);
  assert.equal(duplicateBot.sent.length, sendsAfterFirst);

  console.log(
    'Hybrid Telegram transport contracts passed: allowlist, settings, exclusive routing, callback blocking, screenshot captions and duplicate sends.',
  );
}

async function main() {
  if (process.env.BOOKING_HYBRID_TELEGRAM_TEST_CHILD !== '1') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-telegram-'));
    try {
      execFileSync(process.execPath, [
        '--import', pathToFileURL(require.resolve('tsx')).href,
        __filename,
      ], {
        cwd: directory,
        stdio: 'inherit',
        env: {
          ...process.env,
          BOOKING_HYBRID_TELEGRAM_TEST_CHILD: '1',
          OPENAI_API_KEY: '',
          TELEGRAM_BOT_TOKEN: '',
          TELEGRAM_OPERATOR_IDS: '42',
          AGENT_ORCHESTRATION_MODE: 'hybrid_search',
        },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    return;
  }

  await runChild();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
