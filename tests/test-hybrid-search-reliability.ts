import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Usage, type Model, type ModelResponse } from '@openai/agents';
import { AIRPORT_CATALOG } from '../src/agent/airport-catalog';
import { validateSearchProposal, type SearchProposal } from '../src/agent/hybrid-search-proposal';
import type { HybridSearchAutomation, HybridSearchLogEntry } from '../src/agent/hybrid-search-agent';
import { HybridSearchSessionStore, createEmptyHybridSearchSession } from '../src/storage/hybrid-search-session-store';
import { createFlightSearchSnapshot } from '../src/automation/1booking/flight-search-snapshot';

type Plan = { name: string; args: Record<string, unknown> } | null;
/** SDK model fixture captures attempts and never connects to a provider. */
function model(plans: Plan[], counter = { value: 0 }): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      counter.value++;
      assert.ok(plans.length, 'unexpected model retry');
      const next = plans.shift();
      return {
        usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }),
        output: next ? [{ type: 'function_call', callId: 'call-' + counter.value, name: next.name, arguments: JSON.stringify(next.args) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'untrusted prose' }] }],
      };
    },
    async *getStreamedResponse() { throw Error('unused'); },
  };
}
const text = 'mình muốn bay từ hcm ra nha trang vào ngày 12/12, ưu tiên Vietjet Air';
const complete: SearchProposal = {
  requestMode: 'new_search', fromAirportCode: 'SGN', fromAirportText: 'HCM',
  toAirportCode: 'CXR', toAirportText: 'Nha Trang', departureDate: '2026-12-12',
  preferredAirlineCodes: ['VJ'], tripType: 'one_way',
  evidence: { fromAirport: 'hcm', toAirport: 'nha trang', departureDate: '12/12', airlines: 'Vietjet Air' },
};
const settings = { agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false };
/** Exercise the pure boundary for conflicts and context rules independently of SDK behavior. */
function boundaryContracts() {
  const check = (patch: SearchProposal, message = text, previous?: SearchProposal) => validateSearchProposal({ patch, text: message, previous, todayIso: '2026-09-16' });
  assert.deepEqual(check(complete).issues, []);
  for (const airport of AIRPORT_CATALOG) for (const alias of airport.aliases) {
    const origin = airport.code === 'SGN' ? 'HAN' : 'SGN';
    const resolved = check({ requestMode: 'new_search', fromAirportCode: origin, toAirportText: alias, departureDate: '2026-12-12' }, 'từ ' + origin + ' đến ' + alias + ' ngày 12/12');
    assert.deepEqual(resolved.issues, [], alias);
    assert.equal(resolved.draft.toAirportCode, airport.code, alias);
  }
  assert.ok(check({ ...complete, preferredAirlineCodes: undefined, evidence: undefined }, 'HCM Nha Trang 12/12').issues.some(i => i.reason === 'ambiguous'));

  const conflict = check({ ...complete, fromAirportCode: 'HAN', fromAirportText: 'Tân Sơn Nhất (HAN)' });
  assert.ok(conflict.issues.some(i => i.field === 'fromAirport' && i.reason === 'conflict'));
  assert.equal(conflict.draft.fromAirportCode, undefined);
  assert.deepEqual(conflict.results.find(r => r.field === 'fromAirport' && r.status === 'conflict')?.codes?.sort(), ['HAN', 'SGN']);
  const reversed = check({ ...complete, fromAirportCode: 'CXR', fromAirportText: 'Nha Trang', toAirportCode: 'SGN', toAirportText: 'HCM', evidence: { fromAirport: 'nha trang', toAirport: 'hcm', departureDate: '12/12' } });
  assert.ok(reversed.issues.some(i => i.reason === 'conflict'));
  assert.ok(check({ ...complete, evidence: { ...complete.evidence, toAirport: 'Đà Nẵng' } }).issues.some(i => i.field === 'toAirport'));
  assert.ok(check({ ...complete, toAirportText: 'Nha Trang hoặc Đà Nẵng' }).issues.some(i => i.field === 'toAirport'));
  assert.ok(check(complete, text + ' hoặc 13/12').issues.some(i => i.field === 'departureDate'));
  assert.ok(check(complete, text + ', đúng 8h hoặc 10h').issues.some(i => i.field === 'time'));
  const previous = check(complete).draft;
  previous.preferredTime = 'morning'; previous.resultRanking = 'cheapest';
  const fresh = check({ ...complete, preferredAirlineCodes: undefined, evidence: { fromAirport: 'hcm', toAirport: 'nha trang', departureDate: '12/12' } }, 'từ hcm ra nha trang ngày 12/12', previous);
  assert.deepEqual(fresh.issues, []);
  assert.equal(fresh.draft.preferredAirlineCodes, undefined);
  assert.equal(fresh.draft.preferredTime, undefined);
  assert.equal(fresh.draft.resultRanking, undefined);
  const update = check({ requestMode: 'update_search', departureDate: '2026-09-17', evidence: { departureDate: 'ngày mai' } }, 'đổi sang ngày mai', previous);
  assert.deepEqual(update.issues, []);
  assert.equal(update.draft.departureDate, '2026-09-17');
  assert.deepEqual(update.draft.preferredAirlineCodes, ['VJ']);
  assert.equal(update.draft.preferredTime, 'morning');
  const tomorrowOmitted = check({ requestMode: 'update_search' }, 'đổi sang ngày mai', previous);
  assert.deepEqual(tomorrowOmitted.issues, []);
  assert.equal(tomorrowOmitted.draft.departureDate, '2026-09-17');
  assert.equal(check({ requestMode: 'update_search' }, 'đổi sang ngày mai', { ...previous, preferredTime: 'night' }).draft.preferredTime, 'night');
  assert.ok(check({ requestMode: 'update_search', preferredAirlineCodes: ['VJ'], evidence: { airlines: 'Vietjet' } }, 'không bay Vietjet', previous).issues.some(i => i.field === 'airlines'));
  assert.ok(check({ requestMode: 'update_search' }, 'không sau 10h', previous).issues.some(i => i.field === 'time'));

  const timeOmitted = check({ requestMode: 'update_search' }, 'đổi giờ sau 10h', previous);
  assert.deepEqual(timeOmitted.issues, []);
  assert.equal(timeOmitted.draft.timeConstraint?.kind, 'after');
  assert.equal(timeOmitted.draft.timeConstraint?.startTime, '10:00');
  assert.ok(check({ requestMode: 'update_search', refresh: true }, 'giá rẻ nhất', previous).issues.some(i => i.field === 'intent'));
  assert.equal(check({ requestMode: 'update_search' }, text, previous).mode, 'new_search');
  assert.equal(check({ requestMode: 'update_search' }, text, previous).draft.preferredTime, undefined);
  assert.equal(check({ requestMode: 'new_search' }, 'đổi sang ngày mai', previous).mode, 'update_search');
  assert.ok(check({ ...complete, departureDate: '2026-12-01', evidence: { ...complete.evidence, departureDate: 'mình' } }, 'mình bay từ hcm ra nha trang Vietjet Air').issues.some(i => i.field === 'departureDate'));
  assert.ok(check({ ...complete, toAirportCode: 'VII', toAirportText: 'Trà Vinh', evidence: { ...complete.evidence, toAirport: 'Trà Vinh' } }, text.replace('nha trang', 'Trà Vinh')).issues.some(i => i.field === 'toAirport'));
  assert.ok(check({ ...complete, toAirportCode: 'SGN', toAirportText: 'HCM', evidence: { ...complete.evidence, toAirport: 'hcm' } }, text.replace('nha trang', 'hcm')).issues.some(i => i.field === 'toAirport'));
  assert.equal(check(complete, text.replace('12/12', '12/12 năm sau')).draft.departureDate, '2027-12-12');
  assert.equal(check({ ...complete, evidence: { ...complete.evidence, departureDate: '12/12 năm sau' } }, text.replace('12/12', '12/12 năm sau')).draft.departureDate, '2027-12-12');
  assert.ok(check({ requestMode: 'update_search', clearFields: ['preferredAirlineCodes'], evidence: { clearFields: 'bỏ giờ bay' } }, 'bỏ giờ bay', previous).issues.some(i => i.field === 'airlines'));
  assert.ok(check({ departureDate: '2026-12-13' }, 'ngày 13/12', previous).issues.some(i => i.field === 'intent'));
}

/** End-to-end tool contracts use an isolated case/session directory and fake browser results. */
async function main() {
  boundaryContracts();
  const root = process.cwd();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-reliability-'));
  const priorMode = process.env.AGENT_ORCHESTRATION_MODE;
  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  process.chdir(temporary);
  try {
    const { runHybridSearchTurn } = await import('../src/agent/hybrid-search-agent');
    const store = new HybridSearchSessionStore(path.join(temporary, 'sessions'));
    let searches = 0;
    const logs: HybridSearchLogEntry[] = [];
    const automation: HybridSearchAutomation = async (input) => {
      searches++;
      const snapshot = createFlightSearchSnapshot({
        route: { fromAirportCode: input.fromAirportCode!, fromAirportText: input.fromAirportText!, toAirportCode: input.toAirportCode!, toAirportText: input.toAirportText! },
        departureDate: input.departureDate!, capturedAt: '2026-09-16T04:00:00.000Z',
        candidates: [{ cardIndex: 0, airlineCode: 'VJ', airlineName: 'Vietjet Air', flightNumber: 'VJ600', departureTime: '08:00', arrivalTime: '09:00', bookingClass: 'ECO', rawBookingClassCode: 'ECO', priceText: '1,000,000 VND', priceAmount: 1000000 }],
        observedFlightCount: 1, screenshotPaths: [],
      });
      return { ok: true, snapshot, candidates: snapshot.candidates, flightCount: 1, displayedFlightCount: 1, screenshotPath: '', screenshotPaths: [] };
    };
    const options = { sessionStore: store, automation, now: new Date('2026-09-16T04:00:00Z'), todayIso: '2026-09-16', settingsReader: async () => settings, logger: async (entry: HybridSearchLogEntry) => { logs.push(entry); } };
    const first = { ...complete, toAirportCode: undefined, toAirportText: undefined, evidence: { fromAirport: 'hcm', departureDate: '12/12', airlines: 'Vietjet Air' } };
    const attempts = { value: 0 };
    const repaired = await runHybridSearchTurn(1, text, { ...options, messageId: 1, model: model([{ name: 'search_flights', args: first }, { name: 'search_flights', args: complete }], attempts) });
    assert.equal(repaired.status, 'searched'); assert.equal(searches, 1); assert.equal(attempts.value, 2);
    assert.equal(repaired.snapshot?.route.toAirportCode, 'CXR');
    assert.equal(logs.at(-1)?.repairAttempts, 1); assert.equal(logs.at(-1)?.outcomeStatus, 'searched');
    assert.ok(logs.at(-1)?.validationAttempts?.[0].some(field => field.field === 'toAirport' && field.status === 'missing'));
    assert.equal(JSON.stringify(logs).includes(text), false);
    const duplicate = await runHybridSearchTurn(1, text, { ...options, messageId: 1, model: model([]) });
    assert.equal(duplicate.status, 'duplicate'); assert.equal(searches, 1);

    const bad = { ...complete, fromAirportCode: 'HAN', fromAirportText: 'Tân Sơn Nhất (HAN)' };
    const badAttempts = { value: 0 };
    const blocked = await runHybridSearchTurn(2, text, { ...options, model: model([{ name: 'search_flights', args: bad }, { name: 'search_flights', args: bad }], badAttempts) });
    assert.equal(blocked.status, 'clarification'); assert.equal(badAttempts.value, 2); assert.equal(searches, 1);
    assert.match(blocked.response, /điểm đi/); assert.doesNotMatch(blocked.response, /điểm đến/);

    const missingTwice = await runHybridSearchTurn(3, text, { ...options, model: model([{ name: 'search_flights', args: first }, { name: 'search_flights', args: first }]) });
    assert.equal(missingTwice.status, 'clarification'); assert.equal(searches, 1);
    const restarted = new HybridSearchSessionStore(path.join(temporary, 'sessions'));
    assert.deepEqual((await restarted.read(3))?.pendingClarification?.fields, ['toAirport']);
    const shortReply = await runHybridSearchTurn(3, 'cam ranh', { ...options, sessionStore: restarted, model: model([{ name: 'search_flights', args: { requestMode: 'update_search', toAirportText: 'Cam Ranh', evidence: { toAirport: 'cam ranh' } } }]) });
    assert.equal(shortReply.status, 'searched'); assert.equal(searches, 2);

    const absent = await runHybridSearchTurn(4, 'tìm vé', { ...options, model: model([{ name: 'ask_operator_for_clarification', args: { purpose: 'clarify', target: 'route', draftRequest: { requestMode: 'new_search' } } }]) });
    assert.equal(absent.status, 'clarification'); assert.equal(searches, 2);
    const noneAttempts = { value: 0 };
    const noTool = await runHybridSearchTurn(5, 'xin chào', { ...options, model: model([null, null], noneAttempts) });
    assert.equal(noTool.status, 'error'); assert.equal(noneAttempts.value, 2);
    const mixedAttempts = { value: 0 };
    const mixed = await runHybridSearchTurn(6, text, { ...options, model: model([null, { name: 'search_flights', args: first }], mixedAttempts) });
    assert.equal(mixed.status, 'clarification'); assert.equal(mixedAttempts.value, 2); assert.equal(searches, 2);

    let rateCalls = 0;
    const limitedModel: Model = { ...model([]), async getResponse() { rateCalls++; throw Object.assign(new Error('rate limited'), { status: 429 }); } };
    assert.equal((await runHybridSearchTurn(7, text, { ...options, model: limitedModel })).status, 'error');
    assert.equal(rateCalls, 1);
    let timeoutCalls = 0;
    const slowModel: Model = { ...model([]), async getResponse() { timeoutCalls++; await new Promise(resolve => setTimeout(resolve, 100)); throw Error('late response'); } };
    assert.equal((await runHybridSearchTurn(8, text, { ...options, model: slowModel, modelTimeoutMs: 20 })).status, 'error');
    assert.equal(timeoutCalls, 1);

    let recoveryCalls = 0;
    const firstModel = model([{ name: 'search_flights', args: first }]);
    const recoveryError: Model = { ...firstModel, async getResponse(request) {
      recoveryCalls++;
      if (recoveryCalls === 2) throw Object.assign(new Error('rate limited'), { status: 429 });
      return firstModel.getResponse(request);
    } };
    const safeFailure = await runHybridSearchTurn(9, text, { ...options, model: recoveryError });
    assert.equal(safeFailure.status, 'clarification'); assert.match(safeFailure.response, /điểm đến/);
    assert.equal(recoveryCalls, 2); assert.equal(searches, 2);
    assert.ok((await store.read(9))?.pendingClarification?.fields.includes('toAirport'));

    const state = await store.read(1); assert.ok(state?.snapshot);
    state.draftRequest!.departureDate = '2026-12-13'; await store.write(1, state);
    assert.equal((await store.read(1))?.snapshotFresh, false);
    const stale = await runHybridSearchTurn(1, 'giá rẻ nhất', { ...options, model: model([{ name: 'compare_flights', args: { requestMode: 'update_search', criterion: 'cheapest' } }, { name: 'compare_flights', args: { requestMode: 'update_search', criterion: 'cheapest' } }]) });
    assert.equal(stale.status, 'invalid'); assert.equal(stale.snapshot, undefined); assert.equal(searches, 2);
    state.draftRequest!.departureDate = '2026-12-12'; await store.write(1, state);
    const wrongId = await runHybridSearchTurn(1, 'giá rẻ nhất', { ...options, model: model([{ name: 'compare_flights', args: { criterion: 'cheapest', snapshotId: 'FS-other', candidateIds: ['candidate-0'] } }]) });
    assert.equal(wrongId.status, 'invalid'); assert.equal(searches, 2);
    const multiBase = model([{ name: 'search_flights', args: complete }]);
    const multi: Model = { ...multiBase, async getResponse(request) {
      const response = await multiBase.getResponse(request);
      response.output.push({ type: 'function_call', callId: 'duplicate-tool', name: 'search_flights', arguments: JSON.stringify(complete) });
      return response;
    } };
    const multiResult = await runHybridSearchTurn(10, text, { ...options, model: multi });
    assert.equal(multiResult.status, 'searched'); assert.equal(searches, 3);
    // Ranking changes and clears must override the last comparison in every tool path.
    const rankingState = await store.read(10); assert.ok(rankingState?.snapshot);
    rankingState.snapshot.candidates.push({ ...rankingState.snapshot.candidates[0], candidateId: 'later-cheaper', cardIndex: 1, flightNumber: 'VJ602', departureTime: '12:00', priceAmount: 500000, priceText: '500,000 VND' });
    rankingState.lastCompareCriterion = 'earliest';
    await store.write(10, rankingState);
    const ranked = await runHybridSearchTurn(10, 'ưu tiên rẻ nhất', { ...options, model: model([{ name: 'search_flights', args: { requestMode: 'update_search', resultRanking: 'cheapest', evidence: { ranking: 'rẻ nhất' } } }]) });
    assert.equal(ranked.status, 'searched'); assert.equal(ranked.liveSearchPerformed, false); assert.equal(searches, 3);
    assert.ok(ranked.response.indexOf('VJ602') < ranked.response.indexOf('VJ600'));
    assert.equal((await store.read(10))?.lastCompareCriterion, 'cheapest');
    const cleared = await runHybridSearchTurn(10, 'bỏ ưu tiên giá', { ...options, model: model([{ name: 'search_flights', args: { requestMode: 'update_search', clearFields: ['resultRanking'], evidence: { clearFields: 'bỏ ưu tiên giá' } } }]) });
    assert.equal(cleared.status, 'searched'); assert.equal(cleared.liveSearchPerformed, false); assert.equal(searches, 3);
    assert.equal((await store.read(10))?.lastCompareCriterion, undefined);
    const unclearTime = await runHybridSearchTurn(10, 'giờ thuận tiện', { ...options, model: model([{ name: 'ask_operator_for_clarification', args: { purpose: 'clarify', target: 'time', draftRequest: { requestMode: 'update_search', evidence: { time: 'giờ thuận tiện' } } } }]) });
    assert.equal(unclearTime.status, 'clarification');
    assert.ok((await store.read(10))?.pendingClarification?.fields.includes('time'));
    const oldSession = createEmptyHybridSearchSession(99); await store.write(99, oldSession);
    assert.equal((await store.read(99))?.pendingClarification, undefined);
    console.log('Hybrid reliability contracts passed: evidence, intent, conflicts, one repair, restart, replay, no browser on failure, rate/timeout and snapshot binding.');
  } finally {
    process.chdir(root);
    if (priorMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE; else process.env.AGENT_ORCHESTRATION_MODE = priorMode;
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
