import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HybridSearchAutomation, HybridSearchAgentOptions } from '../src/agent/hybrid-search-agent';
import type { FlightSearchSnapshot } from '../src/automation/1booking/flight-search-snapshot';
import { readAIConnectionConfig, sanitizeAIError } from '../src/agent/ai-provider';

/** Uses real OpenAI decisions with isolated local state and a fake browser search. */
async function main() {
  const aiConfig = readAIConnectionConfig({ defaultModel: 'gpt-5.6-luna' });
  console.log(`Hybrid evaluation provider=${aiConfig.provider} model=${aiConfig.model}`);
  const fixturePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const supplied = fixturePath ? JSON.parse(await fs.readFile(fixturePath, 'utf8')) : undefined;
  const originalDirectory = process.cwd();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-search-eval-'));
  process.chdir(directory);
  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  // Load services after chdir so case files and logs also stay in the eval directory.
  const { runHybridSearchTurn } = require('../src/agent/hybrid-search-agent') as typeof import('../src/agent/hybrid-search-agent');
  const { HybridSearchSessionStore } = require('../src/storage/hybrid-search-session-store') as typeof import('../src/storage/hybrid-search-session-store');
  const { createFlightSearchSnapshot } = require('../src/automation/1booking/flight-search-snapshot') as typeof import('../src/automation/1booking/flight-search-snapshot');
  const store = new HybridSearchSessionStore(path.join(directory, 'sessions'));
  const base: FlightSearchSnapshot = supplied?.snapshot ?? createFlightSearchSnapshot({
    snapshotId: 'eval-initial', capturedAt: '2026-09-14T08:00:00Z',
    route: { fromAirportCode: 'SGN', fromAirportText: 'Ho Chi Minh', toAirportCode: 'HAN', toAirportText: 'Ha Noi' },
    departureDate: '2026-09-21',
    candidates: Array.from({ length: 40 }, (_, index) => ({
      cardIndex: index, airlineCode: 'VJ', airlineName: 'VietJet Air',
      flightNumber: `VJ${100 + index}`, departureTime: `${String(5 + Math.floor(index / 3)).padStart(2, '0')}:${['00', '20', '40'][index % 3]}`,
      arrivalTime: null, bookingClass: null, rawBookingClassCode: null,
      priceAmount: 2_000_000 - index * 10_000, priceText: `${2_000_000 - index * 10_000} VND`,
    })),
  });
  let searches = 0;
  const automation: HybridSearchAutomation = async (input) => {
    searches += 1;
    const snapshot = structuredClone(base);
    snapshot.snapshotId = `eval-observation-${searches}`;
    snapshot.departureDate = input.departureDate!;
    snapshot.route = { fromAirportCode: input.fromAirportCode!, fromAirportText: input.fromAirportText!, toAirportCode: input.toAirportCode!, toAirportText: input.toAirportText! };
    return { ok: true, snapshot, candidates: snapshot.candidates, flightCount: snapshot.candidates.length,
      displayedFlightCount: snapshot.candidates.length, screenshotPath: '', screenshotPaths: [] };
  };
  const options: HybridSearchAgentOptions = {
    automation, sessionStore: store, ownerTelegramUserId: 1,
    now: new Date('2026-09-14T08:00:00Z'), todayIso: '2026-09-14', modelTimeoutMs: 30_000,
    settingsReader: async () => ({ agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false }),
    logger: (entry) => { if (entry.failureReason) console.error(`Evaluation diagnostic: ${entry.failureReason}`); },
  };
  try {
    const deferredFailures: string[] = [];
    const samples = [
      { text: 'Tìm chuyến SGN đi HAN ngày 21/09/2026 giá rẻ nhưng đừng bay quá sớm', count: 0, statuses: ['clarification'] },
      { text: 'Từ 8h sáng nhé', count: 1, statuses: ['searched'] },
      { text: 'Vậy chỉ xem các chuyến sau 10h, vẫn ưu tiên rẻ nhất', count: 1, statuses: ['compared', 'searched'] },
      { text: 'Cập nhật giá mới giúp mình, giữ nguyên tuyến ngày và tiêu chí', count: 2, statuses: ['searched'] },
      { text: 'Giữ chỗ chuyến này luôn', count: 2, statuses: ['clarification', 'unsupported'] },
    ];
    for (const [index, sample] of samples.entries()) {
      const result = await runHybridSearchTurn(-910014, sample.text, { ...options, messageId: index + 1 });
      console.log(JSON.stringify({ sample: index + 1, status: result.status, tool: result.toolName, searches, tokens: result.usage?.totalTokens, response: result.response }));
      assert.equal(searches, sample.count, `Unexpected browser count at sample ${index + 1}`);
      if (index === 4 && !sample.statuses.includes(result.status)) deferredFailures.push(`Unsupported booking request returned ${result.status}`);
      else assert.ok(sample.statuses.includes(result.status), `Unexpected status at sample ${index + 1}: ${result.status}`);
      if (index === 1 || index === 2) {
        const session = await store.read(-910014);
        assert.equal(session?.snapshot?.candidates.length, base.candidates.length);
        assert.equal(session?.draftRequest?.departureDate, '2026-09-21');
        assert.equal(session?.draftRequest?.resultRanking, 'cheapest');
        assert.equal(session?.draftRequest?.timeConstraint?.startTime, index === 1 ? '08:00' : '10:00');
      }
    }
    const replay = await runHybridSearchTurn(-910014, samples[3].text, { ...options, messageId: 4 });
    assert.equal(replay.status, 'duplicate');
    assert.equal(searches, 2);
    const yearless = await runHybridSearchTurn(-910015, 'Tìm SGN đi HAN ngày 30/07, rẻ nhưng đừng bay quá sớm', { ...options, messageId: 1 });
    assert.equal(yearless.status, 'clarification');
    assert.equal((await store.read(-910015))?.draftRequest?.departureDate, '2027-07-30');
    const continued = await runHybridSearchTurn(-910015, 'Từ 8h sáng', { ...options, messageId: 2 });
    console.log(JSON.stringify({ sample: 'yearless_continuation', status: continued.status, searches, date: continued.snapshot?.departureDate }));
    assert.equal(continued.status, 'searched');
    assert.equal(continued.snapshot?.departureDate, '2027-07-30');
    assert.equal(searches, 3);
    const around = await runHybridSearchTurn(-910015, 'Đổi giờ bay 17h nhé', { ...options, messageId: 3 });
    console.log(JSON.stringify({ sample: 'plain_17h_window', status: around.status, searches, response: around.response }));
    assert.ok(['compared', 'searched', 'no_match'].includes(around.status));
    assert.equal(searches, 3);
    const aroundDraft = (await store.read(-910015))?.draftRequest;
    assert.equal(aroundDraft?.timeConstraint?.kind, 'around');
    assert.equal(aroundDraft?.timeConstraint?.exactTime, '17:00');
    assert.deepEqual(deferredFailures, []);
    console.log('Hybrid live-model evaluation passed. Browser automation was injected; no Telegram messages or booking actions were sent.');
  } finally {
    process.chdir(originalDirectory);
    // Keep the isolated evaluation files for diagnosis; print no credentials.
    console.log(`Evaluation state: ${directory}`);
  }
}

main().catch((error) => {
  console.error(sanitizeAIError(error));
  process.exitCode = 1;
});
