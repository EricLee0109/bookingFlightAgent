import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Usage, type Model, type ModelResponse } from '@openai/agents';
import type { HybridSearchAutomation } from '../src/agent/hybrid-search-agent';
import { HybridSearchSessionStore, createEmptyHybridSearchSession } from '../src/storage/hybrid-search-session-store';
import { createFlightSearchSnapshot } from '../src/automation/1booking/flight-search-snapshot';
import { validateSearchProposal } from '../src/agent/hybrid-search-proposal';

/** One deterministic decision per fixture; fail if runtime unexpectedly loops. */
function fakeModel(args: Record<string, unknown>, count = { value: 0 }): Model {
  return { async getResponse(): Promise<ModelResponse> {
    count.value++; assert.ok(count.value <= 2);
    return { usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }), output: [{ type: 'function_call', callId: 'intent-' + count.value, name: 'search_flights', arguments: JSON.stringify(args) }] };
  }, async *getStreamedResponse() { throw Error('unused'); } };
}
const original = { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'CXR', toAirportText: 'Cam Ranh', departureDate: '2026-12-12', preferredTime: 'night' as const, preferredAirlineCodes: ['VN'], resultRanking: 'cheapest' as const };
const proposal = { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'HAN', toAirportText: 'HN', departureDate: '2026-12-10', evidence: { fromAirport: 'hcm', toAirport: 'hn', departureDate: '10/12' } };
const message = 'mình muốn tìm chuyến hcm ra hn vào ngày 10/12';

/** Reproduce the user's multi-turn flow against real SDK/session boundaries, offline. */
async function main() {
  const root = process.cwd(); const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-intent-'));
  const priorMode = process.env.AGENT_ORCHESTRATION_MODE; process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  process.chdir(directory);
  try {
    const { runHybridSearchTurn } = await import('../src/agent/hybrid-search-agent');
    const store = new HybridSearchSessionStore(path.join(directory, 'sessions'));
    const observations: Parameters<HybridSearchAutomation>[0][] = [];
    const automation: HybridSearchAutomation = async input => {
      observations.push(input);
      const snapshot = createFlightSearchSnapshot({ route: { fromAirportCode: input.fromAirportCode!, fromAirportText: input.fromAirportText!, toAirportCode: input.toAirportCode!, toAirportText: input.toAirportText! }, departureDate: input.departureDate!, candidates: [{ cardIndex: 0, airlineCode: 'VN', airlineName: 'Vietnam Airlines', flightNumber: 'VN123', departureTime: '19:10', arrivalTime: '21:10', bookingClass: 'ECO', rawBookingClassCode: 'ECO', priceText: '1000000 VND', priceAmount: 1000000 }], screenshotPaths: [] });
      return { ok: true, snapshot, candidates: snapshot.candidates, flightCount: 1, displayedFlightCount: 1, screenshotPath: '', screenshotPaths: [] };
    };
    const options = { sessionStore: store, automation, todayIso: '2026-09-16', now: new Date('2026-09-16T06:53:00Z'), logger: async () => {}, settingsReader: async () => ({ agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false }) };
    const seed = async (chat: number) => { const state = createEmptyHybridSearchSession(chat); state.draftRequest = { ...original }; await store.write(chat, state); };
    await seed(1);
    const directCalls = { value: 0 };
    const direct = await runHybridSearchTurn(1, message, { ...options, messageId: 10, model: fakeModel({ ...proposal, requestMode: 'update_search' }, directCalls) });
    assert.equal(direct.status, 'searched'); assert.equal(directCalls.value, 1);
    assert.equal(observations.at(-1)?.toAirportCode, 'HAN'); assert.equal(observations.at(-1)?.departureDate, '2026-12-10');
    assert.equal(observations.at(-1)?.preferredTime ?? null, null); assert.equal(observations.at(-1)?.preferredAirlineCodes ?? null, null);
    assert.equal((await store.read(1))?.pendingClarification, undefined);
    const beforeDuplicate = observations.length;
    assert.equal((await runHybridSearchTurn(1, message, { ...options, messageId: 10, model: fakeModel(proposal) })).status, 'duplicate');
    assert.equal(observations.length, beforeDuplicate);

    // Existing stuck version-1 sessions must recover on the complete request too.
    const stuck = createEmptyHybridSearchSession(2); stuck.draftRequest = { tripType: 'one_way', missingFields: [] }; stuck.pendingClarification = { fields: ['intent', 'fromAirport', 'toAirport'] }; await store.write(2, stuck);
    assert.equal((await runHybridSearchTurn(2, message, { ...options, model: fakeModel({ ...proposal, requestMode: 'new_search' }) })).status, 'searched');

    // Truly unspecified intent preserves validated facts through repair and restart.
    for (const [chat, answer] of [[3, 'tìm chuyến mới'], [4, 'cập nhật yêu cầu hiện tại']] as const) {
      await seed(chat); const count = observations.length;
      const ambiguous = await runHybridSearchTurn(chat, 'hcm ra hn ngày 10/12', { ...options, model: fakeModel({ ...proposal, requestMode: 'unsure' }) });
      assert.equal(ambiguous.status, 'clarification'); assert.equal(observations.length, count);
      const pending = await store.read(chat);
      assert.equal(pending?.draftRequest?.toAirportCode, 'CXR');
      assert.equal(pending?.pendingClarification?.intentDraft?.toAirportCode, 'HAN');
      assert.equal(pending?.pendingClarification?.intentDraft?.departureDate, '2026-12-10');
      assert.equal(pending?.pendingClarification?.intentDraft?.preferredTime, undefined);
      const undecided = await runHybridSearchTurn(chat, 'ừ', { ...options, model: fakeModel({ requestMode: 'update_search' }) });
      assert.equal(undecided.status, 'clarification'); assert.equal(observations.length, count);
      assert.equal((await store.read(chat))?.pendingClarification?.intentDraft?.toAirportCode, 'HAN');
      const restarted = new HybridSearchSessionStore(path.join(directory, 'sessions'));
      const accepted = await runHybridSearchTurn(chat, answer, { ...options, sessionStore: restarted, model: fakeModel({ requestMode: 'new_search' }) });
      assert.equal(accepted.status, 'searched'); assert.equal(observations.length, count + 1);
      assert.equal(observations.at(-1)?.toAirportCode, 'HAN');
      assert.equal(observations.at(-1)?.preferredTime ?? null, chat === 3 ? null : 'night');
      assert.deepEqual(observations.at(-1)?.preferredAirlineCodes ?? null, chat === 3 ? null : ['VN']);
      assert.equal((await store.read(chat))?.pendingClarification, undefined);
    }
    // Confirmation is not permission to invent a different date or consume unresolved time.
    const checked = validateSearchProposal({ text: 'tìm chuyến mới', todayIso: '2026-09-16', previous: original, pending: { fields: ['intent', 'time'], intentDraft: { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'HAN', toAirportText: 'HN', departureDate: '2026-12-10' } }, patch: {} });
    assert.ok(checked.issues.some(i => i.field === 'time'));
    for (const answer of ['tìm chuyến mới đi', 'đúng rồi, tìm chuyến mới nha', 'cập nhật chuyến hiện tại giúp mình']) {
      const confirmed = validateSearchProposal({ text: answer, todayIso: '2026-09-16', previous: original, pending: { fields: ['intent'], intentDraft: { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'HAN', toAirportText: 'HN', departureDate: '2026-12-10' } }, patch: {} });
      assert.deepEqual(confirmed.issues, [], answer);
      assert.equal(confirmed.draft.toAirportCode, 'HAN', answer);
    }
    const forged = validateSearchProposal({ text: 'tìm chuyến mới', todayIso: '2026-09-16', pending: { fields: ['intent'], intentDraft: { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'HAN', toAirportText: 'HN', departureDate: '2026-12-10' } }, patch: { departureDate: '2026-12-11' } });
    assert.ok(forged.issues.some(i => i.field === 'departureDate'));
    console.log('Intent regressions passed: HCM-HN, model mode mismatch, stuck session, staged facts, restart, new/update confirmations, no silent old filters, ambiguous replies and forged edits.');
  } finally {
    process.chdir(root); if (priorMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE; else process.env.AGENT_ORCHESTRATION_MODE = priorMode;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
