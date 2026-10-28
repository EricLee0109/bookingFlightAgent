import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Agent, Runner, RunState, Usage, tool, type Model, type ModelResponse } from '@openai/agents';
import { z } from 'zod';
import { availableBookingTools, bookingAgentCaseSnapshot, readAgentOrchestrationMode, redactAgentMessage } from '../src/agent/booking-agent-policy';
import { createShadowBookingAgent, runShadowBookingAgent } from '../src/agent/booking-agent';
import { AgentSessionStore } from '../src/storage/agent-session-store';
import { createLocalFlightCase, readLocalFlightCase, saveLocalFlightCase, updateLocalFlightCase, type LocalFlightCase } from '../src/storage/local-case-store';
import { consumeHoldApproval, decideHoldApproval, holdFingerprint, requestHoldApproval, requiresHoldApproval, withHoldClaim } from '../src/services/hold-approval-service';
import { mayStartTelegramHold, tryHandleHoldApprovalCallback } from '../src/telegram/telegram-hold-approval';
import { fillPassengerAndHoldOneBookingCase } from '../src/services/passenger-hold-automation-service';
import type TelegramBot from 'node-telegram-bot-api';

const settings = { agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false };

/** Supplies deterministic model responses while exercising the actual SDK runner. */
function fakeModel(name: string, args: object): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      return { usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 10 }),
        output: [{ type: 'function_call', callId: 'test-call', name, arguments: JSON.stringify(args) }] };
    },
    async *getStreamedResponse() { throw new Error('Streaming is not used in this test.'); },
  };
}

/** Verifies approval, restart, state isolation and shadow behavior without external calls. */
async function main() {
  const oldMode = process.env.AGENT_ORCHESTRATION_MODE;
  process.env.AGENT_ORCHESTRATION_MODE = 'legacy';
  const caseId = 'BK-20990910-010101';
  const casePath = path.resolve('data/cases', `${caseId}.json`);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'booking-agent-contract-'));
  assert.equal(await readLocalFlightCase(caseId), null, 'Never overwrite an existing case fixture.');
  const fixture: LocalFlightCase = {
    caseId, telegramChatId: 123, status: 'PASSENGER_INFO_CONFIRMED', rawMessage: 'test only',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    searchInput: { fromAirportCode: 'HAN', fromAirportText: 'Hà Nội', toAirportCode: 'SGN', toAirportText: 'Sài Gòn', departureDate: '2099-10-10' },
    selectedFlight: { cardIndex: 0, airlineCode: 'VJ', airlineName: 'Vietjet', flightNumber: 'VJ123', departureTime: '10:00', arrivalTime: '12:00', bookingClass: 'ECO', rawBookingClassCode: 'ECO', priceText: '1.000.000 VND', selectedAt: new Date().toISOString() },
    attachedPassengerInfo: { lastName: 'TEST', firstName: 'PASSENGER', gender: 'F', dob: '1990-01-01' },
  };
  try {
    const created = await Promise.all([createLocalFlightCase('synthetic one', 101), createLocalFlightCase('synthetic two', 202)]);
    assert.notEqual(created[0].caseId, created[1].caseId);
    assert.equal((await readLocalFlightCase(created[0].caseId))!.telegramChatId, 101);
    assert.equal((await readLocalFlightCase(created[1].caseId))!.telegramChatId, 202);
    assert.equal(readAgentOrchestrationMode('legacy'), 'legacy');
    assert.equal(readAgentOrchestrationMode('shadow'), 'shadow');
    assert.throws(() => readAgentOrchestrationMode('hybrid'));
    assert.equal(requiresHoldApproval(settings), true);
    assert.equal(requiresHoldApproval({ ...settings, autoHoldBooking: true, requireConfirmationBeforeHold: false }), false);
    process.env.AGENT_ORCHESTRATION_MODE = 'shadow';
    assert.equal(requiresHoldApproval({ ...settings, autoHoldBooking: true, requireConfirmationBeforeHold: false }), true);
    process.env.AGENT_ORCHESTRATION_MODE = 'legacy';

    await saveLocalFlightCase(fixture);
    process.env.ONE_BOOKING_HOLD_PHONENUMBER = '0900000000';
    process.env.ONE_BOOKING_HOLD_EMAIL = 'synthetic@example.com';
    process.env.ONE_BOOKING_HOLD_NAME = 'Synthetic Test';
    const directResult = await fillPassengerAndHoldOneBookingCase(caseId);
    assert.equal(directResult.ok, false, 'Direct service caller cannot bypass approval.');
    if (!directResult.ok) assert.match(directResult.message, /xác nhận/);
    await assert.rejects(() => consumeHoldApproval(fixture, settings), /xác nhận/);
    await assert.rejects(() => requestHoldApproval(caseId, 999), /cuộc trò chuyện/);
    const messages: Array<{ text: string; options?: TelegramBot.SendMessageOptions }> = [];
    const bot = { async sendMessage(_chat: number, text: string, options?: TelegramBot.SendMessageOptions) { messages.push({ text, options }); } } as unknown as TelegramBot;
    assert.equal(await mayStartTelegramHold(bot, 123, caseId), false);
    const review = (await readLocalFlightCase(caseId))!;
    assert.equal(review.status, 'AWAITING_HOLD_APPROVAL');
    const buttons = messages[0].options!.reply_markup as TelegramBot.InlineKeyboardMarkup;
    assert.equal(buttons.inline_keyboard[0][0].text, 'Xác nhận giữ chỗ');
    assert.ok(Buffer.byteLength(buttons.inline_keyboard[0][0].callback_data!) <= 64);
    assert.ok(messages[0].text.includes('1.000.000 VND'));
    await assert.rejects(() => decideHoldApproval(caseId, review.holdApproval!.token, 999, 7, true));
    await updateLocalFlightCase(review, { selectedFlight: { ...fixture.selectedFlight!, priceText: '2.000.000 VND' } });
    await assert.rejects(() => decideHoldApproval(caseId, review.holdApproval!.token, 123, 7, true), /thay đổi/);
    const changedReview = await requestHoldApproval(caseId, 123);
    assert.notEqual(changedReview.holdApproval!.token, review.holdApproval!.token);
    await updateLocalFlightCase(changedReview, { holdApproval: { ...changedReview.holdApproval!, expiresAt: '2000-01-01' } });
    await assert.rejects(() => decideHoldApproval(caseId, changedReview.holdApproval!.token, 123, 7, true));
    let fresh = await requestHoldApproval(caseId, 123);
    const rejected = await decideHoldApproval(caseId, fresh.holdApproval!.token, 123, 7, false);
    await assert.rejects(() => consumeHoldApproval(rejected, settings));
    fresh = await requestHoldApproval(caseId, 123);
    let executions = 0;
    const callback = `h:yes:${caseId}:${fresh.holdApproval!.token}`;
    const execute = async () => withHoldClaim(caseId, async () => {
      const current = (await readLocalFlightCase(caseId))!;
      await consumeHoldApproval(current, settings);
      executions++;
    });
    await tryHandleHoldApprovalCallback(bot, 123, 7, callback, execute);
    await tryHandleHoldApprovalCallback(bot, 123, 7, callback, execute);
    assert.equal(executions, 1, 'Replayed Telegram approval cannot execute twice.');
    const consumed = (await readLocalFlightCase(caseId))!;
    assert.equal(consumed.holdApproval!.status, 'consumed');
    await assert.rejects(() => consumeHoldApproval(consumed, settings));
    await assert.rejects(() => requestHoldApproval(caseId, 123), /sẵn sàng/);
    await withHoldClaim(caseId, async () => {
      await assert.rejects(() => withHoldClaim(caseId, async () => { executions++; }), /gián đoạn/);
    });
    const claimPath = path.resolve('data/hold-claims', `${caseId}.lock`);
    await fs.writeFile(claimPath, '', { flag: 'wx' });
    try { await assert.rejects(() => withHoldClaim(caseId, async () => { executions++; }), /gián đoạn/); }
    finally { await fs.unlink(claimPath); }
    await updateLocalFlightCase(consumed, { status: 'HOLD_NEEDS_REVIEW', holdSubmittedAt: new Date().toISOString() });
    await assert.rejects(() => requestHoldApproval(caseId, 123));
    assert.notEqual(holdFingerprint(fixture), holdFingerprint({ ...fixture, attachedPassengerInfo: { ...fixture.attachedPassengerInfo!, firstName: 'CHANGED' } }));

    assert.ok(!availableBookingTools(null).includes('hold_booking'));
    assert.ok(availableBookingTools(fixture).includes('hold_booking'));
    assert.ok(!availableBookingTools({ ...fixture, status: 'HOLD_SUCCESS' }).includes('hold_booking'));
    const snapshot = JSON.stringify(bookingAgentCaseSnapshot(fixture));
    assert.ok(!snapshot.includes('1990-01-01') && !snapshot.includes('"firstName"'));
    const redacted = redactAgentMessage('sinh 10/10/1990 email demo@example.com +84901234567', true);
    assert.ok(!redacted.includes('1990') && !redacted.includes('@') && !redacted.includes('84901234567'));
    assert.ok(redactAgentMessage('bay ngày 2099-10-10', false).includes('2099-10-10'));

    const model = fakeModel('ask_operator_for_clarification', { question: 'Bạn ưu tiên giá hay giờ bay?' });
    const decision = await runShadowBookingAgent('tìm chuyến bay tốt nhất', null, { model });
    assert.equal(decision.result.interruptions.length, 1, 'SDK pauses the proposed tool.');
    const store = new AgentSessionStore(temporary);
    await store.write(123, { history: [{ role: 'user', content: decision.input }], updatedAt: new Date().toISOString(), pausedState: decision.result.state.toString() });
    assert.equal(await new AgentSessionStore(temporary).read(999), null);
    const saved = (await new AgentSessionStore(temporary).read(123))!;
    const shadowAgent = createShadowBookingAgent(null, model);
    const restored = await RunState.fromString(shadowAgent, saved.pausedState!);
    restored.approve(restored.getInterruptions()[0]);
    // Shadow executor still fails after an accidental SDK approval.
    shadowAgent.toolUseBehavior = 'stop_on_first_tool';
    const shadowResult = await new Runner({ tracingDisabled: true }).run(shadowAgent, restored);
    assert.match(String(shadowResult.finalOutput), /error/i);

    // Independently prove the SDK approval/resume lifecycle with a fake hold only.
    let fakeHolds = 0;
    const fakeHoldAgent = new Agent({ name: 'ApprovalContract', model: fakeModel('fake_hold', {}), toolUseBehavior: 'stop_on_first_tool',
      tools: [tool({ name: 'fake_hold', description: 'Test fixture only', parameters: z.object({}), needsApproval: true,
        execute: async () => { fakeHolds++; return 'FAKE-PNR'; } })] });
    const runner = new Runner({ tracingDisabled: true });
    const paused = await runner.run(fakeHoldAgent, 'hold');
    assert.equal(fakeHolds, 0);
    const resumed = await RunState.fromString(fakeHoldAgent, paused.state.toString());
    resumed.approve(resumed.getInterruptions()[0]);
    const completed = await runner.run(fakeHoldAgent, resumed);
    assert.equal(completed.finalOutput, 'FAKE-PNR');
    assert.equal(fakeHolds, 1);
    const failingModel: Model = { ...model, async getResponse() { throw new Error('synthetic provider failure'); } };
    await assert.rejects(() => runShadowBookingAgent('test', null, { model: failingModel }), /synthetic/);
    const slowModel: Model = { ...model, getResponse(request) {
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Abort was not delivered.')), 1000);
        request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(request.signal!.reason); }, { once: true });
      });
    } };
    await assert.rejects(() => runShadowBookingAgent('test', null, { model: slowModel, timeoutMs: 25 }));
    console.log('Hybrid foundation contracts passed: approval, replay, expiry, ownership, claim, redaction, SDK shadow and restart/resume. No live booking or OpenAI call.');
  } finally {
    if (oldMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE;
    else process.env.AGENT_ORCHESTRATION_MODE = oldMode;
    await fs.unlink(casePath);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Runs with an isolated working directory so stores never touch operator data. */
async function runIsolated() {
  if (process.env.BOOKING_TEST_CHILD === '1') return main();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'booking-agent-isolated-'));
  try {
    execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, __filename], {
      cwd: directory, stdio: 'inherit',
      env: { ...process.env, BOOKING_TEST_CHILD: '1', OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '' },
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

runIsolated().catch((error) => { console.error(error); process.exitCode = 1; });
