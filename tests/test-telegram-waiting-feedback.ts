import assert from 'node:assert/strict';
import { handleTelegramHybridSearchMessage } from '../src/telegram/telegram-hybrid-search';

const settings = { agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false };
const result = { ok: true, status: 'clarification', response: 'Bạn muốn bay ngày nào?', message: 'Bạn muốn bay ngày nào?', screenshotPaths: [], screenshotBatches: [], liveSearchPerformed: false };
const message = { message_id: 123, from: { id: 42 }, chat: { id: 700 }, text: 'Tìm chuyến giúp mình' };
const previousMode = process.env.AGENT_ORCHESTRATION_MODE;
const previousOperators = process.env.TELEGRAM_OPERATOR_IDS;
type Sent = { text: string; options?: Record<string, unknown> };

async function main() {
  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  process.env.TELEGRAM_OPERATOR_IDS = '42';
  try {
    const sent: Sent[] = [];
    let resolveStarted!: () => void;
    let releaseResult!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseResult = resolve; });
    const bot = { sendMessage: async (_chat: number, text: string, options?: Record<string, unknown>) => { sent.push({ text, options }); return { message_id: 999 }; } };
    const pending = handleTelegramHybridSearchMessage(bot as never, message as never, {
      settingsReader: async () => settings,
      runTurn: async (_chat, _text, options) => {
        await (options as any)?.onProcessingStarted?.();
        resolveStarted();
        await gate;
        return result as never;
      },
    });
    await started;
    try {
      assert.equal(sent.length, 1, 'waiting feedback must be visible while result is still pending');
      assert.match(sent[0].text, /đang xử lý/i);
      assert.equal(sent[0].options?.reply_to_message_id, 123);
      assert.equal(sent[0].options?.allow_sending_without_reply, true);
    } finally {
      releaseResult();
      await pending;
    }
    assert.equal(sent.length, 2);
    assert.equal(sent[1].text, result.response);

    for (const behavior of ['reject', 'throw', 'timeout'] as const) {
      let sends = 0;
      let rejectDelayed!: (error: Error) => void;
      const failures: unknown[] = [];
      const onUnhandled = (error: unknown) => failures.push(error);
      process.on('unhandledRejection', onUnhandled);
      const failingBot = {
        sendMessage: (_chat: number, text: string) => {
          sends += 1;
          if (sends > 1) { assert.equal(text, result.response); return Promise.resolve({ message_id: 1000 }); }
          if (behavior === 'throw') throw new Error('simulated notification failure');
          if (behavior === 'reject') return Promise.reject(new Error('simulated notification failure'));
          return new Promise((_resolve, reject) => { rejectDelayed = reject; });
        },
      };
      const start = Date.now();
      try {
        await handleTelegramHybridSearchMessage(failingBot as never, message as never, {
          settingsReader: async () => settings,
          runTurn: async (_chat, _text, options) => {
            await (options as any)?.onProcessingStarted?.();
            return result as never;
          },
        });
        assert.equal(sends, 2, `${behavior}: final answer still delivered`);
        assert.ok(Date.now() - start < 3000, `${behavior}: notification wait is bounded`);
        if (behavior === 'timeout') rejectDelayed(new Error('late notification failure'));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(failures.length, 0, `${behavior}: no escaped rejection`);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    }
    console.log('Telegram waiting feedback passed: visible before result, reply linkage, sync/async failure isolation, bounded timeout and late rejection handling. No network calls.');
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE;
    else process.env.AGENT_ORCHESTRATION_MODE = previousMode;
    if (previousOperators === undefined) delete process.env.TELEGRAM_OPERATOR_IDS;
    else process.env.TELEGRAM_OPERATOR_IDS = previousOperators;
  }
}

const watchdog = setTimeout(() => {
  console.error('Waiting-feedback test did not finish; a notification may be blocking the turn.');
  process.exit(1);
}, 10_000);
main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog));

