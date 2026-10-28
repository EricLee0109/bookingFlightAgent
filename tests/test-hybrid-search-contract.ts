import assert from 'node:assert/strict';
import { zodResponseFormat } from 'openai/helpers/zod';
import {
  HYBRID_AIRPORT_CATALOG,
  HybridSearchFlightRequestSchema,
  parseHybridTimeConstraintFromVietnameseText,
  resolveHybridDepartureDate,
  validateHybridFlightRequest,
} from '../src/agent/hybrid-flight-request';
import {
  buildHybridInstructions,
  type HybridSearchAgentContext,
} from '../src/agent/hybrid-search-agent';
import { createEmptyHybridSearchSession } from '../src/storage/hybrid-search-session-store';
import {
  buildHybridTimeConstraintFilter,
  isFlightCandidateInTimeFilter,
} from '../src/automation/1booking/flight-time-filters';
import {
  createFlightSearchSnapshot,
  filterFlightSearchSnapshot,
  formatFlightSearchSnapshotReply,
  isSameFlightSearchRouteAndDate,
  screenshotsForFlightSearchResult,
} from '../src/automation/1booking/flight-search-snapshot';
import type { FlightResultCandidate } from '../src/automation/1booking/flight-result-types';

const route = {
  fromAirportCode: 'HAN',
  fromAirportText: 'Sân bay Nội Bài (HAN)',
  toAirportCode: 'SGN',
  toAirportText: 'Sân bay Tân Sơn Nhất (SGN)',
};

function candidate(cardIndex: number, priceAmount: number | null, departureTime = `${String(cardIndex % 24).padStart(2, '0')}:00`): FlightResultCandidate {
  return {
    cardIndex,
    airlineCode: cardIndex % 2 ? 'VN' : 'VJ',
    airlineName: cardIndex % 2 ? 'Vietnam Airlines' : 'Vietjet Air',
    flightNumber: `${cardIndex % 2 ? 'VN' : 'VJ'}${100 + cardIndex}`,
    departureTime,
    arrivalTime: null,
    bookingClass: 'ECO',
    rawBookingClassCode: 'ECO',
    priceText: priceAmount === null ? null : `${priceAmount.toLocaleString('en-US')} VND`,
    priceAmount,
  };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    ...route,
    departureDate: '2026-09-20',
    returnDate: null,
    preferredTime: null,
    specificTime: null,
    resultRanking: null,
    preferredAirlineCodes: null,
    tripType: 'one_way',
    missingFields: [],
    ...overrides,
  };
}

/** Verifies the pilot schema remains a provider-compatible root object. */
function testProviderSchema() {
  assert.equal(zodResponseFormat(HybridSearchFlightRequestSchema, 'hybrid_request').type, 'json_schema');
}

/** Verifies yearless dates roll forward, including the next valid leap day. */
function testDateBoundaries() {
  assert.equal(resolveHybridDepartureDate(null, '30/07', '2026-09-14').departureDate, '2027-07-30');
  assert.equal(resolveHybridDepartureDate(null, '29/02', '2026-09-14').departureDate, '2028-02-29');
  assert.equal(resolveHybridDepartureDate(null, '31/11', '2026-09-14').ok, false);
  assert.equal(resolveHybridDepartureDate('2026-09-13', '13/09/2026', '2026-09-14').reason, 'past_date');
  assert.equal(resolveHybridDepartureDate('2027-02-29', undefined, '2026-09-14').reason, 'invalid_date');

  const resolved = validateHybridFlightRequest(validRequest({ departureDate: '2026-09-14' }), {
    todayIso: '2026-09-14',
    now: new Date('2026-09-14T02:00:00.000Z'),
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, 'today_needs_cutoff');
}

/** Verifies routes/catalog/airline/unsupported request validation. */
function testRequestValidation() {
  const missingRoute = validateHybridFlightRequest(validRequest({
    fromAirportCode: null,
    fromAirportText: null,
  }), { todayIso: '2026-09-14' });
  assert.equal(missingRoute.ok, false);
  if (!missingRoute.ok) assert.equal(missingRoute.reason, 'missing_fields');

  const unknownRoute = validateHybridFlightRequest(validRequest({
    fromAirportCode: 'XXX',
    fromAirportText: 'Sân bay XXX',
  }), { todayIso: '2026-09-14' });
  assert.equal(unknownRoute.ok, false);
  if (!unknownRoute.ok) assert.equal(unknownRoute.reason, 'missing_fields');

  const sameAirport = validateHybridFlightRequest(validRequest({
    toAirportCode: 'HAN',
    toAirportText: route.fromAirportText,
  }), { todayIso: '2026-09-14' });
  assert.equal(sameAirport.ok, false);
  if (!sameAirport.ok) assert.equal(sameAirport.reason, 'missing_fields');

  const unknownAirline = validateHybridFlightRequest(validRequest({ preferredAirlineCodes: ['Mystery Air'] }), { todayIso: '2026-09-14' });
  assert.equal(unknownAirline.ok, false);
  if (!unknownAirline.ok) assert.equal(unknownAirline.reason, 'unknown_airline');

  const unsupported = validateHybridFlightRequest(validRequest({ tripType: 'round_trip' }), { todayIso: '2026-09-14' });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.reason, 'unsupported_request');

  const malformedTime = validateHybridFlightRequest(validRequest({
    timeConstraint: { kind: 'from', startTime: '25:00', endTime: null, exactTime: null, startInclusive: true, endInclusive: false },
  }), { todayIso: '2026-09-14' });
  assert.equal(malformedTime.ok, false);

  const todayWithSpecificTime = validateHybridFlightRequest(validRequest({
    departureDate: '2026-09-14',
    preferredTime: 'specific_time',
    specificTime: '17:00',
  }), { todayIso: '2026-09-14' });
  assert.equal(todayWithSpecificTime.ok, true);

  const malformedSpecificTime = validateHybridFlightRequest(validRequest({
    preferredTime: 'specific_time',
    specificTime: '25:00',
  }), { todayIso: '2026-09-14' });
  assert.equal(malformedSpecificTime.ok, false);

  const conflictingTime = validateHybridFlightRequest(validRequest({
    timeConstraint: { kind: 'from', startTime: '08:00', endTime: '12:00', exactTime: null, startInclusive: true, endInclusive: false },
  }), { todayIso: '2026-09-14' });
  assert.equal(conflictingTime.ok, false);
}

/** Verifies catalog aliases, targeted route prompts, and retained yearful dates. */
function testVietnameseRouteRecovery() {
  const hcm = HYBRID_AIRPORT_CATALOG.find((airport) => airport.aliases.includes('hcm'));
  assert.equal(hcm?.code, 'SGN');

  const persistedDraft = validateHybridFlightRequest(validRequest({
    fromAirportCode: null,
    fromAirportText: 'HCM',
    toAirportCode: 'UIH',
    toAirportText: 'Phù Cát',
    departureDate: '2027-02-01',
  }), {
    rawText: 'điểm đi là HCM và điểm đến là Qui Nhơn',
    todayIso: '2026-09-14',
  });
  assert.equal(persistedDraft.ok, true);
  if (persistedDraft.ok) {
    assert.equal(persistedDraft.request.fromAirportCode, 'SGN');
    assert.equal(persistedDraft.request.toAirportCode, 'UIH');
    assert.equal(persistedDraft.request.departureDate, '2027-02-01');
  }

  const missingFrom = validateHybridFlightRequest(validRequest({
    fromAirportCode: null,
    fromAirportText: null,
  }), { todayIso: '2026-09-14' });
  assert.equal(missingFrom.ok, false);
  if (!missingFrom.ok) {
    assert.deepEqual(missingFrom.missingFields, ['fromAirportCode', 'fromAirportText']);
    assert.equal(missingFrom.message, 'Bạn cho mình biết điểm đi nhé.');
  }

  const missingTo = validateHybridFlightRequest(validRequest({
    toAirportCode: null,
    toAirportText: null,
  }), { todayIso: '2026-09-14' });
  assert.equal(missingTo.ok, false);
  if (!missingTo.ok) {
    assert.deepEqual(missingTo.missingFields, ['toAirportCode', 'toAirportText']);
    assert.equal(missingTo.message, 'Bạn cho mình biết điểm đến nhé.');
  }
}

/** Verifies the model is directed to the catalog and clarification tool for help. */
function testHybridPromptContract() {
  const context = {
    chatId: 1,
    text: 'xin chào',
    session: createEmptyHybridSearchSession(1),
    sessionStore: {} as HybridSearchAgentContext['sessionStore'],
    automation: async () => { throw new Error('unused'); },
    settingsReader: async () => ({
      agentEnabled: true,
      autoSearchFlights: true,
      autoHoldBooking: false,
      requireConfirmationBeforeHold: true,
      debugMode: false,
    }),
    now: new Date('2026-09-14T02:00:00.000Z'),
    liveSearchPerformed: false,
  } satisfies HybridSearchAgentContext;
  const prompt = buildHybridInstructions(context);
  assert.match(prompt, /Danh mục sân bay chính thức/);
  assert.match(prompt, /"code":"SGN"/);
  assert.match(prompt, /"hcm"/);
  assert.match(prompt, /chào hỏi/);
  assert.match(prompt, /trợ giúp/);
  assert.match(prompt, /ask_operator_for_clarification/);
  assert.match(prompt, /purpose là greeting, help, clarify hoặc unsupported/);
  assert.match(prompt, /question là trường cũ tùy chọn/);
  assert.match(prompt, /Không trả lời bằng văn bản tự do ngoài tool/);
}

/** Verifies exact, directional, interval, and around-time boundary semantics. */
function testTimeBoundaries() {
  const cases = [
    ['bay17h', 'around', '15:00', '19:00'],
    ['khoang17h', 'around', '15:00', '19:00'],
    ['dung17h', 'exact', '17:00', '17:00'],
    ['tu17h', 'from', '17:00', '23:59'],
    ['khong truoc17h', 'from', '17:00', '23:59'],
    ['truoc17h', 'before', '00:00', '17:00'],
    ['sau17h', 'after', '17:00', '23:59'],
    ['tu08h den12h', 'between', '08:00', '12:00'],
  ] as const;
  for (const [text, kind, start, end] of cases) {
    const parsed = parseHybridTimeConstraintFromVietnameseText(text)!;
    assert.equal(parsed.kind, kind);
    const filter = buildHybridTimeConstraintFilter(parsed);
    assert.equal(filter.startMinute, Number(start.slice(0, 2)) * 60);
    assert.equal(filter.endMinute, Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5)));
  }
  const around = buildHybridTimeConstraintFilter(parseHybridTimeConstraintFromVietnameseText('bay17h')!);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '15:00'), around), true);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '19:00'), around), true);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '14:59'), around), false);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '19:01'), around), false);
  const from = buildHybridTimeConstraintFilter(parseHybridTimeConstraintFromVietnameseText('tu17h')!);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '17:00'), from), true);
  const before = buildHybridTimeConstraintFilter(parseHybridTimeConstraintFromVietnameseText('truoc17h')!);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '17:00'), before), false);
  const after = buildHybridTimeConstraintFilter(parseHybridTimeConstraintFromVietnameseText('sau17h')!);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '17:00'), after), false);
  const exclusiveRange = buildHybridTimeConstraintFilter({
    kind: 'between',
    startTime: '08:00',
    endTime: '12:00',
    exactTime: null,
    startInclusive: false,
    endInclusive: false,
  });
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '08:00'), exclusiveRange), false);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '10:00'), exclusiveRange), true);
  assert.equal(isFlightCandidateInTimeFilter(candidate(1, 1_000_000, '12:00'), exclusiveRange), false);
  const combined = parseHybridTimeConstraintFromVietnameseText('sau08h truoc12h')!;
  assert.equal(combined.kind, 'between');
  assert.equal(combined.startInclusive, false);
  assert.equal(combined.endInclusive, false);
  assert.equal(combined.startTime, '08:00');
  assert.equal(combined.endTime, '12:00');
}

/** Verifies full snapshot retention, stable IDs, screenshot mapping, and ranking. */
function testSnapshotAndDeterministicCompare() {
  const observed = Array.from({ length: 37 }, (_, index) => candidate(index, index === 5 ? null : 1_000_000 + (index % 4) * 100_000));
  const snapshot = createFlightSearchSnapshot({
    snapshotId: 'FS-test-1',
    capturedAt: '2026-09-14T03:00:00.000Z',
    route,
    departureDate: '2026-09-20',
    candidates: observed,
    screenshotPaths: ['one.png', 'two.png', 'three.png', 'four.png'],
    observedFlightCount: 37,
  });
  assert.equal(snapshot.candidates.length, 37);
  assert.equal(new Set(snapshot.candidates.map((item) => item.candidateId)).size, 37);
  assert.deepEqual(snapshot.screenshots[0].candidateIds, snapshot.candidates.slice(0, 10).map((item) => item.candidateId));
  assert.deepEqual(snapshot.screenshots[3].candidateIds, snapshot.candidates.slice(30).map((item) => item.candidateId));
  assert.equal(isSameFlightSearchRouteAndDate(snapshot, { ...route, departureDate: '2026-09-20' }), true);

  const cheapest = filterFlightSearchSnapshot(snapshot, { resultRanking: 'cheapest', limit: 5 }, { todayIso: '2026-09-14' });
  assert.equal(cheapest.selectedCandidates.length, 5);
  assert.equal(cheapest.selectedCandidates.every((item) => item.priceAmount !== null), true);
  assert.equal(cheapest.selectedCandidates[0].priceAmount, 1_000_000);
  assert.equal(cheapest.noMatches, false);

  const noMatch = filterFlightSearchSnapshot(snapshot, {
    timeConstraint: { kind: 'exact', startTime: null, endTime: null, exactTime: '23:30', startInclusive: true, endInclusive: true },
  }, { todayIso: '2026-09-14' });
  assert.equal(noMatch.noMatches, true);
  assert.equal(noMatch.candidates.length, 37);

  assert.throws(() => filterFlightSearchSnapshot(snapshot, { preferredAirlineCodes: ['Mystery Air'] }));
  assert.throws(() => screenshotsForFlightSearchResult(snapshot, ['candidate-does-not-exist']));
  assert.deepEqual(screenshotsForFlightSearchResult(snapshot, [snapshot.candidates[15].candidateId]), [], 'older mixed batches must not be sent as filtered images');

  const noPrices = createFlightSearchSnapshot({ route, departureDate: '2026-09-20', candidates: [candidate(0, null)] });
  const unrankable = filterFlightSearchSnapshot(noPrices, { resultRanking: 'cheapest' }, { todayIso: '2026-09-14' });
  assert.equal(unrankable.unrankable, true);
  assert.equal(unrankable.noMatches, false);
  assert.throws(() => filterFlightSearchSnapshot(noPrices, {
    timeConstraint: {
      kind: 'between',
      startTime: '20:00',
      endTime: '08:00',
      exactTime: null,
      startInclusive: true,
      endInclusive: true,
    },
  }));

  const yesterday = createFlightSearchSnapshot({
    route,
    departureDate: '2026-09-13',
    candidates: [candidate(1, 1_000_000, '23:59')],
  });
  const yesterdayResult = filterFlightSearchSnapshot(yesterday, {}, { todayIso: '2026-09-14' });
  assert.equal(yesterdayResult.noMatches, true);
  assert.equal(yesterdayResult.summary.excludedPastDepartureCount, 1);

  const sameDay = createFlightSearchSnapshot({
    route,
    departureDate: '2026-09-14',
    candidates: [candidate(1, 1_000_000, '17:00'), candidate(2, 1_100_000, '17:01')],
  });
  const sameDayResult = filterFlightSearchSnapshot(
    sameDay,
    {},
    { now: new Date('2026-09-14T10:00:30.000Z'), todayIso: '2026-09-14' },
  );
  assert.deepEqual(sameDayResult.matchedCandidates.map((item) => item.departureTime), ['17:01']);

  const subsetPastCount = filterFlightSearchSnapshot(
    sameDay,
    { candidateIds: [sameDay.candidates[1].candidateId] },
    { now: new Date('2026-09-14T10:00:30.000Z'), todayIso: '2026-09-14' },
  );
  assert.equal(subsetPastCount.summary.excludedPastDepartureCount, 0);

  const formatted = formatFlightSearchSnapshotReply(snapshot, cheapest);
  assert.equal(formatted.candidateIds.length, 5);
  assert.match(formatted.text, /Kết quả/);
}

testProviderSchema();
testDateBoundaries();
testRequestValidation();
testVietnameseRouteRecovery();
testHybridPromptContract();
testTimeBoundaries();
testSnapshotAndDeterministicCompare();
console.log('Hybrid search contract tests passed: schema, dates, time bounds, full snapshots, deterministic compare, no-match and ID validation.');
