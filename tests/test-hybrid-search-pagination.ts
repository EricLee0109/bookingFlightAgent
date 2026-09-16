import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Usage, type Model, type ModelResponse } from '@openai/agents';
import { createFlightSearchSnapshot, filterFlightSearchSnapshot } from '../src/automation/1booking/flight-search-snapshot';
import { HybridSearchSessionStore } from '../src/storage/hybrid-search-session-store';

async function main() {
  // Run in a subprocess so tsx/native worker working-directory handles are closed before cleanup.
  if (process.env.BOOKING_PAGINATION_TEST_CHILD !== '1') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-pages-'));
    try {
      execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, __filename], {
        cwd: directory, stdio: 'inherit', env: { ...process.env, BOOKING_PAGINATION_TEST_CHILD: '1', OPENAI_API_KEY: '', NINE_ROUTER_API_KEY: '', TELEGRAM_BOT_TOKEN: '' },
      });
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    return;
  }
  const root = process.cwd();
  const dir = process.cwd();
  const previousMode = process.env.AGENT_ORCHESTRATION_MODE;
  const previousOperators = process.env.TELEGRAM_OPERATOR_IDS;
  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  process.env.TELEGRAM_OPERATOR_IDS = '42';
  process.chdir(dir);
  try {
    const { runHybridSearchTurn, runHybridSearchPage } = await import('../src/agent/hybrid-search-agent');
    const { handleTelegramHybridSearchMessage, handleTelegramHybridSearchPageCallback } = await import('../src/telegram/telegram-hybrid-search');
    const { handleTelegramCallbackQuery } = await import('../src/telegram/telegram-passenger-message-handler');
    const store = new HybridSearchSessionStore();
    const settingsReader = async () => ({ agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false });
    const options = { sessionStore: store, settingsReader, now: new Date('2026-09-16T08:00:00Z'), todayIso: '2026-09-16', logger: async () => {} };
    let modelCalls = 0, browserCalls = 0;
    function model(name: string, args: object): Model {
      return {
        async getResponse(): Promise<ModelResponse> {
          modelCalls++;
          return { usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }), output: [{ type: 'function_call', callId: 'page-' + modelCalls, name, arguments: JSON.stringify(args) }] };
        }, async *getStreamedResponse() { throw new Error('unused'); },
      };
    }
    const snapshot = createFlightSearchSnapshot({
      snapshotId: 'FS-pagination', capturedAt: options.now,
      route: { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'HAN', toAirportText: 'Hà Nội' }, departureDate: '2026-12-10',
      candidates: Array.from({ length: 57 }, (_, index) => ({ cardIndex: index, airlineCode: index % 2 ? 'VN' : 'VJ', airlineName: index % 2 ? 'Vietnam Airlines' : 'Vietjet Air', flightNumber: 'VJ' + (100 + index), departureTime: String(5 + index % 19).padStart(2, '0') + ':00', arrivalTime: null, bookingClass: 'ECO' as const, rawBookingClassCode: 'ECO', priceText: null, priceAmount: 2_000_000 - index * 1000 })),
      screenshotPaths: Array.from({ length: 57 }, (_, i) => 'card-' + i + '.png'), screenshotBatchSize: 1,
    });
    const result = await runHybridSearchTurn(700, 'mình muốn tìm chuyến hcm ra hn vào ngày 10/12', {
      ...options, messageId: 1, model: model('search_flights', { requestMode: 'new_search', fromAirportText: 'hcm', toAirportText: 'hn', departureDate: '2026-12-10', evidence: { fromAirport: 'hcm', toAirport: 'hn', departureDate: '10/12' } }),
      automation: async () => { browserCalls++; return { ok: true, snapshot, candidates: snapshot.candidates, flightCount: 57, displayedFlightCount: 5, screenshotPath: '', screenshotPaths: [] }; },
    });
    assert.equal(result.status, 'searched');
    assert.ok(result.response.includes('1–5/57'));
    assert.equal(result.pagination?.pageCount, 12);
    assert.equal(result.screenshotBatches.length, 5);
    const token = result.pagination!.token;
    const ids: string[] = [];
    for (let page = 0; page < 12; page++) {
      const response = await runHybridSearchPage(700, token, page, { ...options, sessionStore: new HybridSearchSessionStore(), messageId: 'page-' + page });
      assert.equal(response.status, 'inspected');
      assert.equal(response.liveSearchPerformed, false);
      const expected = snapshot.candidates.slice(page * 5, page * 5 + 5).map(c => c.candidateId);
      assert.deepEqual(response.screenshotBatches.flatMap(b => b.candidateIds), expected);
      assert.deepEqual(response.screenshotBatches.map(b => b.path), expected.map(id => 'card-' + id.split('-')[1] + '.png'));
      assert.deepEqual(response.flightChoices?.map(c => c.callbackData), expected.map((_, i) => `hc:select:${token}:${page * 5 + i}`));
      ids.push(...expected);
      if (page === 11) assert.ok(response.response.includes('56–57/57'));
    }
    assert.equal(new Set(ids).size, 57);
    assert.equal((await runHybridSearchPage(700, token, 1, { ...options, messageId: 'page-1' })).status, 'duplicate');
    for (const page of [-1, 12, 1.5, Number.NaN]) assert.equal((await runHybridSearchPage(700, token, page, options)).status, 'invalid');
    assert.equal((await runHybridSearchPage(701, token, 1, options)).status, 'invalid');
    assert.equal((await runHybridSearchPage(700, 'forged-token', 1, options)).status, 'invalid');
    assert.equal((await runHybridSearchPage(700, token, 1, { ...options, settingsReader: async () => ({ ...await settingsReader(), agentEnabled: false }) })).status, 'disabled');
    assert.equal(modelCalls, 1); assert.equal(browserCalls, 1);

    // The actual transport exposes navigation only after the exact page images.
    const sent: { kind: string; text?: string; photo?: string; options?: any }[] = [];
    const bot = { sendMessage: async (_chat: number, text: string, opts?: object) => { sent.push({ kind: 'message', text, options: opts }); }, sendPhoto: async (_chat: number, photo: string, opts?: object) => { sent.push({ kind: 'photo', photo, options: opts }); }, answerCallbackQuery: async () => { sent.push({ kind: 'answer' }); } } as never;
    await handleTelegramHybridSearchMessage(bot, { message_id: 10, chat: { id: 700 }, from: { id: 42 }, text: 'tìm chuyến' } as never, { settingsReader, runTurn: async () => result });
    assert.equal(sent.filter(s => s.kind === 'photo').length, 5);
    const choiceMessage = sent.find(s => s.options?.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data?.startsWith('hc:select:')));
    assert.ok(choiceMessage);
    assert.equal(choiceMessage.options.reply_markup.inline_keyboard.length, 5);
    assert.ok(sent.indexOf(choiceMessage) > sent.findLastIndex(s => s.kind === 'photo'));
    const nextButton = sent.at(-1)!.options.reply_markup.inline_keyboard[0][0];
    assert.equal(nextButton.text, 'Trang sau ➡️');
    assert.ok(Buffer.byteLength(nextButton.callback_data) <= 64);
    const query = { id: 'transport-page', from: { id: 42 }, message: { chat: { id: 700 } }, data: nextButton.callback_data } as never;
    sent.length = 0;
    await handleTelegramHybridSearchPageCallback(bot, query, { runPage: (chat, t, p, opts) => runHybridSearchPage(chat, t, p, { ...options, ...opts }), settingsReader });
    assert.deepEqual(sent.filter(s => s.kind === 'photo').map(s => s.photo), ['card-5.png', 'card-6.png', 'card-7.png', 'card-8.png', 'card-9.png']);
    assert.equal(sent.at(-1)!.options.reply_markup.inline_keyboard[0].length, 2);
    const sentCount = sent.length;
    await handleTelegramHybridSearchPageCallback(bot, query, { runPage: (chat, t, p, opts) => runHybridSearchPage(chat, t, p, { ...options, ...opts }), settingsReader });
    assert.equal(sent.length, sentCount);
    sent.length = 0;
    await handleTelegramHybridSearchPageCallback(bot, { ...query as any, from: { id: 99 } }, { runPage: async () => { throw Error('unauthorized runner'); } });
    assert.match(sent[0].text!, /chưa có quyền/);
    // Real callback router still blocks the legacy hold family, acknowledges pages.
    sent.length = 0;
    await handleTelegramCallbackQuery(bot, { ...query as any, id: 'router-page' });
    assert.equal(sent[0].kind, 'answer');
    assert.ok(!sent.some(s => /chỉ hỗ trợ tìm và so sánh/.test(s.text ?? '')));
    sent.length = 0;
    await handleTelegramCallbackQuery(bot, { ...query as any, data: 'hold_approval:BK-old', id: 'hold' });
    assert.ok(sent.some(s => /chỉ hỗ trợ tìm và so sánh/.test(s.text ?? '')));

    // Old buttons expire on filter changes even when the same snapshot is reused.
    const filtered = await runHybridSearchTurn(700, 'chỉ buổi tối', { ...options, model: model('compare_flights', { requestMode: 'update_search', preferredTime: 'night', evidence: { time: 'buổi tối' } }) });
    assert.equal(filtered.status, 'compared');
    assert.notEqual(filtered.pagination?.token, token);
    assert.equal((await runHybridSearchPage(700, token, 1, options)).status, 'invalid');
    assert.equal(browserCalls, 1);
    const currentToken = filtered.pagination!.token;
    const saved = (await store.read(700))!;
    const mutate = async (update: (session: typeof saved) => void) => {
      const state = structuredClone(saved); update(state); await store.write(700, state);
      assert.equal((await runHybridSearchPage(700, currentToken, 0, options)).status, 'invalid');
      await store.write(700, saved);
    };
    await mutate(s => { s.pendingClarification = { fields: ['time'] }; });
    await mutate(s => { s.draftRequest!.departureDate = '2026-12-11'; });
    await mutate(s => { s.snapshotFresh = false; });
    await mutate(s => { s.resultView!.snapshotId = 'other'; });
    await mutate(s => { s.resultView!.candidateIds[0] = 'candidate-unknown'; });
    await mutate(s => { s.resultView!.candidateIds.reverse(); });
    assert.equal((await runHybridSearchPage(700, currentToken, 0, { ...options, now: new Date('2026-12-11T08:00:00Z'), todayIso: '2026-12-11' })).status, 'invalid');
    for (const criterion of ['cheapest', 'earliest', 'latest'] as const) {
      const expected = filterFlightSearchSnapshot(snapshot, { criterion }, options).rankedCandidateIds;
      const actual = Array.from({ length: 12 }, (_, i) => filterFlightSearchSnapshot(snapshot, { criterion, offset: i * 5 }, options).selectedCandidates.map(c => c.candidateId)).flat();
      assert.deepEqual(actual, expected);
    }
    const ranked = await runHybridSearchTurn(700, 'rẻ nhất', { ...options, model: model('compare_flights', { requestMode: 'update_search', criterion: 'cheapest', evidence: { ranking: 'rẻ nhất' } }) });
    assert.equal(ranked.status, 'compared');
    const rankedSession = (await store.read(700))!;
    const secondRanked = await runHybridSearchPage(700, ranked.pagination!.token, 1, options);
    assert.equal(secondRanked.status, 'inspected');
    assert.deepEqual(secondRanked.screenshotBatches.flatMap(b => b.candidateIds), rankedSession.resultView!.candidateIds.slice(5, 10));
    assert.equal(browserCalls, 1);
    const noPrices = { ...snapshot, candidates: snapshot.candidates.map(c => ({ ...c, priceAmount: null })) };
    assert.equal(filterFlightSearchSnapshot(noPrices, { criterion: 'cheapest' }, options).unrankable, true);
    console.log('Pagination passed: 57 flights across 12 pages, exact images, restart, replay, transport buttons, stale filters/snapshot/IDs, ranking, no extra model/browser calls.');
  } finally {
    process.chdir(root);
    if (previousMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE; else process.env.AGENT_ORCHESTRATION_MODE = previousMode;
    if (previousOperators === undefined) delete process.env.TELEGRAM_OPERATOR_IDS; else process.env.TELEGRAM_OPERATOR_IDS = previousOperators;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
