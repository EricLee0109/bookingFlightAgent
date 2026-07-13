import assert from 'node:assert/strict';
import { AIRPORT_CATALOG } from '../src/agent/airport-catalog';
import {
  resolveAirportByCode,
  resolveAirportFromText,
} from '../src/agent/airport-resolver';
import {
  mapParsedRequestToSearchFlightsInput,
  normalizeParsedAirportFieldsForSearch,
} from '../src/agent/search-flight-input-mapper';
import {
  createFlightRequestParser,
  getFlightParserProvider,
} from '../src/agent/flight-request-parser-factory';
import {
  normalizeParsedSpecificTimeFromRawMessage,
  parseSpecificTimeFromVietnameseText,
} from '../src/agent/flight-time-normalizer';
import { parseFlightSelectionMessage } from '../src/agent/flight-selection-parser';
import {
  buildFlightParserSystemPrompt,
  createOpenAIFlightRequestParser,
} from '../src/agent/openai-flight-request-parser';
import {
  OneBookingAuthRefreshError,
  readOneBookingCredentialsFromEnv,
} from '../src/automation/1booking/auth';
import { matchFlightSelectionCandidate } from '../src/automation/1booking/flight-selection';
import {
  extractLowestVndPriceAmount,
  getFlightTimeBucketForPreferredTime,
  isFlightTimeInBucket,
  parseFlightCardText,
  rankFlightResultsForSearch,
  resolveFlightTimeFilter,
  selectFlightResultsForSearch,
  type FlightResultCandidate,
} from '../src/automation/1booking/flight-result-ranking';
import {
  closeOneBookingImportantNoticeDrawer,
  OneBookingAuthExpiredError,
  throwIfOneBookingLoginModalVisible,
} from '../src/automation/1booking/waiters';
import { ParsedFlightRequestSchema } from '../src/contracts/flight';
import {
  getLatestFlightSearchCase,
  setLatestFlightSearchCase,
} from '../src/telegram/telegram-flight-selection-context';
import {
  buildCheapestBucketSearchPatch,
  buildCheapestMoreSearchPatch,
  buildNormalBucketSearchPatch,
  canShowCheapestMoreOptionsForCase,
  looksLikeMoreCheapestOptionsRequest,
  parseCheapestBucketFollowUpMessage,
  parseCheapestMoreSearchRequest,
  parseNormalFlightFollowUpRequest,
} from '../src/telegram/telegram-message-handler';
import {
  formatFlightSelectionFailedMessage,
  formatFlightSelectionParseFailedMessage,
  formatMissingFlightFieldsMessage,
  formatSearchFailedMessage,
  formatSearchSuccessMessage,
  formatSearchInputMappingFailedMessage,
} from '../src/telegram/telegram-formatters';

const validOneWayRequest = {
  fromAirportCode: 'HAN',
  fromAirportText: 'San bay Noi Bai (HAN)',
  toAirportCode: 'SGN',
  toAirportText: 'San bay Tan Son Nhat (SGN)',
  departureDate: '2026-05-20',
  returnDate: null,
  preferredTime: 'morning',
  specificTime: null,
  resultRanking: null,
  tripType: 'one_way',
  missingFields: [],
} as const;

/**
 * Verifies that the parser schema accepts a complete one-way request.
 */
function testValidOneWaySchema() {
  const parsed = ParsedFlightRequestSchema.parse(validOneWayRequest);

  assert.equal(parsed.fromAirportCode, 'HAN');
  assert.equal(parsed.tripType, 'one_way');
}

/**
 * Verifies that round-trip requests cannot omit returnDate.
 */
function testRoundTripRequiresReturnDate() {
  assert.throws(() =>
    ParsedFlightRequestSchema.parse({
      ...validOneWayRequest,
      tripType: 'round_trip',
      returnDate: null,
      missingFields: ['returnDate'],
    }),
  );
}

/**
 * Verifies that mapper blocks incomplete parser output before automation.
 */
function testMapperRejectsMissingFields() {
  const parsed = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    departureDate: null,
    missingFields: ['departureDate'],
  });

  assert.throws(
    () => mapParsedRequestToSearchFlightsInput(parsed),
    /Missing fields: departureDate/,
  );
}

/**
 * Verifies that mapper replaces AI display text with canonical airport labels.
 */
function testMapperCanonicalizesAirportText() {
  const parsed = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    fromAirportText: 'San bay Noi Bai (HAN)',
    toAirportText: 'San bay Tan Son Nhat (SGN)',
  });
  const input = mapParsedRequestToSearchFlightsInput(parsed);

  assert.equal(input.fromAirportText, 'Sân bay Nội Bài (HAN)');
  assert.equal(input.toAirportText, 'Sân bay Tân Sơn Nhất (SGN)');
}

/**
 * Verifies that mapper can recover when AI returns airport text but misses code.
 */
function testMapperResolvesAirportTextFallback() {
  const parsed = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    fromAirportCode: 'SGN',
    fromAirportText: 'San bay Tan Son Nhat (SGN)',
    toAirportCode: null,
    toAirportText: 'cam ranh',
    departureDate: '2026-06-25',
    missingFields: [],
  });
  const input = mapParsedRequestToSearchFlightsInput(parsed);

  assert.equal(input.fromAirportCode, 'SGN');
  assert.equal(input.toAirportCode, 'CXR');
  assert.equal(input.toAirportText, 'Cam Ranh International Airport (CXR)');
}

/**
 * Verifies that parsed missing airport codes can be normalized before handler checks.
 */
function testParsedAirportNormalizationBeforeMissingFieldCheck() {
  const parsed = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    toAirportCode: null,
    toAirportText: 'cam ranh',
    missingFields: ['toAirportCode'],
  });
  const normalized = normalizeParsedAirportFieldsForSearch(parsed);

  assert.equal(normalized.toAirportCode, 'CXR');
  assert.equal(normalized.toAirportText, 'Cam Ranh International Airport (CXR)');
}

/**
 * Verifies that the Vietnam airport catalog resolves common operator aliases.
 */
function testAirportCatalogAliases() {
  const airportCodes = AIRPORT_CATALOG.map((airport) => airport.code);

  assert.equal(new Set(airportCodes).size, airportCodes.length);
  assert.equal(resolveAirportFromText('khach muon bay da nang')?.code, 'DAD');
  assert.equal(resolveAirportFromText('di duong dong ngay mai')?.code, 'PQC');
  assert.equal(resolveAirportFromText('can ve di quy nhon')?.code, 'UIH');
  assert.equal(resolveAirportFromText('bay den lien khuong')?.code, 'DLI');
  assert.equal(resolveAirportFromText('bay den long thanh')?.code, 'LTH');
}

/**
 * Verifies that the OpenAI parser prompt is generated from the airport catalog.
 */
function testOpenAIParserPromptIncludesAirportCatalog() {
  const prompt = buildFlightParserSystemPrompt('2026-05-19', 'Asia/Ho_Chi_Minh');

  assert.match(prompt, /cam ranh.*CXR/i);
  assert.match(prompt, /da nang.*DAD/i);
}

/**
 * Verifies the standardized time buckets and cheapest-ranking schema contract.
 */
function testFlightTimeBucketAndRankingSchema() {
  const prompt = buildFlightParserSystemPrompt('2026-05-19', 'Asia/Ho_Chi_Minh');
  const parsed = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    preferredTime: 'early_morning',
    resultRanking: 'cheapest',
  });

  assert.equal(parsed.preferredTime, 'early_morning');
  assert.equal(parsed.resultRanking, 'cheapest');
  assert.match(prompt, /early_morning/);
  assert.match(prompt, /00:00-05:59/);
  assert.match(prompt, /resultRanking to cheapest/);
  assert.match(prompt, /rẻ nhất/);
}

/**
 * Verifies deterministic Vietnamese exact-time normalization before automation.
 */
function testVietnameseSpecificTimeNormalization() {
  assert.deepEqual(parseSpecificTimeFromVietnameseText('bay khoang 17h'), {
    kind: 'time',
    time: '17:00',
    rawText: '17h',
  });
  assert.deepEqual(parseSpecificTimeFromVietnameseText('bay tam 17g30'), {
    kind: 'time',
    time: '17:30',
    rawText: '17g30',
  });
  assert.deepEqual(parseSpecificTimeFromVietnameseText('bay luc 17 gio 30'), {
    kind: 'time',
    time: '17:30',
    rawText: '17 gio 30',
  });
  assert.deepEqual(parseSpecificTimeFromVietnameseText('bay 5h sang'), {
    kind: 'time',
    time: '05:00',
    rawText: '5h',
  });
  assert.deepEqual(parseSpecificTimeFromVietnameseText('bay 5 gio chieu'), {
    kind: 'time',
    time: '17:00',
    rawText: '5 gio',
  });
  assert.deepEqual(parseSpecificTimeFromVietnameseText('bay 5h'), {
    kind: 'ambiguous',
    rawText: '5h',
    hour: 5,
  });

  const normalized = normalizeParsedSpecificTimeFromRawMessage(
    {
      ...validOneWayRequest,
      preferredTime: 'afternoon',
      specificTime: null,
    },
    'bay buoi chieu khoang 17h',
  );

  assert.equal(normalized.ok, true);

  if (!normalized.ok) {
    throw new Error('Expected specific-time normalization to succeed.');
  }

  assert.equal(normalized.parsed.preferredTime, 'specific_time');
  assert.equal(normalized.parsed.specificTime, '17:00');
}

/**
 * Verifies the production mapper airport lookup path.
 */
function testAirportCatalogCodeLookup() {
  assert.equal(resolveAirportByCode('DAD')?.text, 'Da Nang International Airport (DAD)');
  assert.equal(resolveAirportByCode('dad')?.code, 'DAD');
  assert.equal(resolveAirportByCode('XXX'), null);
}

/**
 * Verifies that selection parsing does not invent a booking class.
 */
function testFlightSelectionParserLeavesBookingClassUnspecified() {
  const result = parseFlightSelectionMessage(
    'BK-20260520-155949 chọn Vietjet lúc 5h00',
  );

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || !result.ok) {
    throw new Error('Expected valid selection parse result.');
  }

  assert.equal(result.input.caseId, 'BK-20260520-155949');
  assert.equal(result.input.airlineCode, 'VJ');
  assert.equal(result.input.departureTime, '05:00');
  assert.equal(result.input.bookingClass, null);
}

/**
 * Verifies that selection parsing maps booking class aliases.
 */
function testFlightSelectionParserBookingClassAliases() {
  const deluxe = parseFlightSelectionMessage(
    'BK-20260520-155949 chọn VJ 05:00 deluxe',
  );
  const skyBoss = parseFlightSelectionMessage(
    'BK-20260520-155949 chọn VJ 05:00 skyboss',
  );
  const skyBossBusiness = parseFlightSelectionMessage(
    'BK-20260520-155949 chọn VJ 05:00 SkyBoss Business',
  );

  assert.equal(deluxe.isSelectionMessage && deluxe.ok && deluxe.input.bookingClass, 'DLX');
  assert.equal(skyBoss.isSelectionMessage && skyBoss.ok && skyBoss.input.bookingClass, 'SGB');
  assert.equal(
    skyBossBusiness.isSelectionMessage &&
      skyBossBusiness.ok &&
      skyBossBusiness.input.bookingClass,
    'SBB',
  );
}

/**
 * Verifies that selection parser asks for missing time before automation.
 *
 * Airline is optional because refreshed live cards can still identify one
 * unique match by departure time and booking class.
 */
function testFlightSelectionParserRejectsMissingFields() {
  const result = parseFlightSelectionMessage('BK-20260520-155949 chọn chuyến này');

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || result.ok) {
    throw new Error('Expected invalid selection parse result.');
  }

  assert.deepEqual(result.missingFields, ['departureTime']);
}

/**
 * Verifies natural `case nay` selection resolves against per-chat latest case
 * context without requiring the operator to repeat the BK id or airline.
 */
function testFlightSelectionParserUsesLatestCaseContext() {
  const result = parseFlightSelectionMessage(
    'mình lấy chuyến 8h40 của case này',
    {
      latestCaseId: 'BK-20260601-092749',
    },
  );

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || !result.ok) {
    throw new Error('Expected valid latest-case selection parse result.');
  }

  assert.equal(result.resolvedCaseFromContext, true);
  assert.equal(result.input.caseId, 'BK-20260601-092749');
  assert.equal(result.input.departureTime, '08:40');
  assert.equal(result.input.airlineCode, null);
  assert.equal(result.input.bookingClass, null);
}

/**
 * Verifies natural selection wording can use the latest flight-list case
 * without requiring the operator to type `case này`.
 */
function testFlightSelectionParserUsesImplicitLatestCaseContext() {
  const result = parseFlightSelectionMessage(
    'mình muốn đặt chuyến Vietjet 22h15',
    {
      latestCaseId: 'BK-20260609-113604',
    },
  );

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || !result.ok) {
    throw new Error('Expected valid implicit latest-case selection parse result.');
  }

  assert.equal(result.resolvedCaseFromContext, true);
  assert.equal(result.input.caseId, 'BK-20260609-113604');
  assert.equal(result.input.airlineCode, 'VJ');
  assert.equal(result.input.departureTime, '22:15');
  assert.equal(result.input.bookingClass, null);
}

/**
 * Verifies polite operator wording with `chọn chuyến bay` is also selection.
 */
function testFlightSelectionParserAcceptsNaturalChooseAlias() {
  const result = parseFlightSelectionMessage(
    'chị chọn chuyến bay Vietjet 22h15',
    {
      latestCaseId: 'BK-20260609-113604',
    },
  );

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || !result.ok) {
    throw new Error('Expected valid natural choose selection parse result.');
  }

  assert.equal(result.input.caseId, 'BK-20260609-113604');
  assert.equal(result.input.airlineCode, 'VJ');
  assert.equal(result.input.departureTime, '22:15');
}

/**
 * Verifies natural latest-case selection asks for a case when no flight list is
 * available in the chat context.
 */
function testFlightSelectionParserRequiresContextForImplicitLatestCase() {
  const result = parseFlightSelectionMessage(
    'mình muốn đặt chuyến Vietjet 22h15',
  );

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || result.ok) {
    throw new Error('Expected missing implicit latest-case parse result.');
  }

  assert.deepEqual(result.missingFields, ['caseId']);
}

/**
 * Verifies normal search wording is not claimed by the selection parser.
 */
function testFlightSelectionParserDoesNotClaimSearchRequest() {
  const result = parseFlightSelectionMessage(
    'mình muốn bay từ SGN ra HAN ngày 30/07',
    {
      latestCaseId: 'BK-20260609-113604',
    },
  );

  assert.deepEqual(result, {
    isSelectionMessage: false,
  });
}

/**
 * Verifies combined passenger wording still parses the selected flight only.
 */
function testFlightSelectionParserAcceptsCombinedPassengerMessage() {
  const result = parseFlightSelectionMessage(
    'case này lấy chuyến 13h30 Vietjet cho chị Oanh',
    {
      latestCaseId: 'BK-20260607-141109',
    },
  );

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || !result.ok) {
    throw new Error('Expected valid combined selection parse result.');
  }

  assert.equal(result.input.caseId, 'BK-20260607-141109');
  assert.equal(result.input.airlineCode, 'VJ');
  assert.equal(result.input.departureTime, '13:30');
  assert.equal(result.input.bookingClass, null);
}

/**
 * Verifies `case nay` asks for a case id when no latest search context exists.
 */
function testFlightSelectionParserRequiresLatestCaseContext() {
  const result = parseFlightSelectionMessage('chọn chuyến 8h40 của case này');

  assert.equal(result.isSelectionMessage, true);

  if (!result.isSelectionMessage || result.ok) {
    throw new Error('Expected missing latest-case parse result.');
  }

  assert.deepEqual(result.missingFields, ['caseId']);
}

/**
 * Verifies per-chat latest flight search context storage.
 */
function testLatestFlightSearchCaseContext() {
  setLatestFlightSearchCase(456, 'BK-20260601-092749');

  assert.deepEqual(getLatestFlightSearchCase(456), {
    latestSearchCaseId: 'BK-20260601-092749',
  });
}

/**
 * Verifies cheapest bucket follow-up replies are combined into the latest case.
 */
function testCheapestBucketFollowUpPatch() {
  const earlyMorning = parseCheapestBucketFollowUpMessage('sáng sớm');
  const allCheapest = parseCheapestBucketFollowUpMessage(
    'tất cả chuyến rẻ nhất',
  );
  const searchRequest = parseCheapestBucketFollowUpMessage(
    'mình muốn bay từ SGN ra HAN ngày 30/07',
  );

  assert.deepEqual(earlyMorning, {
    preferredTime: 'early_morning',
    label: 'Sáng sớm',
  });
  assert.deepEqual(allCheapest, {
    preferredTime: null,
    label: 'Tất cả chuyến rẻ nhất',
  });
  assert.equal(searchRequest, null);

  if (!earlyMorning || !allCheapest) {
    throw new Error('Expected bucket follow-up parse results.');
  }

  const parsedRequest = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    preferredTime: 'morning',
    resultRanking: 'cheapest',
  });
  const searchInput = mapParsedRequestToSearchFlightsInput(parsedRequest);

  const earlyPatch = buildCheapestBucketSearchPatch(
    {
      searchInput,
      parsedRequest,
    },
    earlyMorning,
  );

  assert.equal(earlyPatch.searchInput?.preferredTime, 'early_morning');
  assert.equal(earlyPatch.searchInput?.resultRanking, 'cheapest');
  assert.equal(earlyPatch.parsedRequest?.preferredTime, 'early_morning');
  assert.equal(earlyPatch.parsedRequest?.resultRanking, 'cheapest');

  const allPatch = buildCheapestBucketSearchPatch(
    {
      searchInput,
      parsedRequest,
    },
    allCheapest,
  );

  assert.equal(allPatch.searchInput?.preferredTime, null);
  assert.equal(allPatch.searchInput?.resultRanking, 'cheapest');
  assert.equal(allPatch.parsedRequest?.preferredTime, null);

  const tenFlightBucketPatch = buildCheapestBucketSearchPatch(
    {
      searchInput: {
        ...searchInput,
        resultLimit: 10,
      },
      parsedRequest,
    },
    earlyMorning,
  );

  assert.equal(tenFlightBucketPatch.searchInput?.resultLimit, 10);
}

/**
 * Verifies explicit cheap-flight follow-ups rerun the latest normal case.
 */
function testCheapestMoreSearchPatch() {
  assert.equal(parseCheapestMoreSearchRequest('them chuyen bay'), null);
  assert.equal(parseCheapestMoreSearchRequest('5 chuyen bay'), null);
  assert.equal(parseCheapestMoreSearchRequest('10 chuyen bay'), null);
  assert.deepEqual(parseCheapestMoreSearchRequest('them chuyen bay gia re'), {
    resultLimit: 5,
  });
  assert.deepEqual(parseCheapestMoreSearchRequest('5 chuyen bay gia re'), {
    resultLimit: 5,
  });
  assert.deepEqual(
    parseCheapestMoreSearchRequest('5 chuyen re nhat buoi chieu'),
    {
      resultLimit: 5,
      preferredTime: 'afternoon',
      bucketLabel: 'buổi chiều',
    },
  );
  assert.deepEqual(
    parseCheapestMoreSearchRequest('them chuyen gia re vao sang som'),
    {
      resultLimit: 5,
      preferredTime: 'early_morning',
      bucketLabel: 'sáng sớm',
    },
  );
  assert.deepEqual(parseCheapestMoreSearchRequest('10 chuyen bay gia re toi'), {
    resultLimit: 10,
    preferredTime: 'night',
    bucketLabel: 'buổi tối',
  });
  assert.equal(parseCheapestMoreSearchRequest('toi can them'), null);
  assert.equal(
    parseCheapestMoreSearchRequest('minh muon bay tu HCM ra HN ngay 22/07'),
    null,
  );

  const parsedRequest = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    preferredTime: 'morning',
    resultRanking: null,
  });
  const morningSearchInput = mapParsedRequestToSearchFlightsInput(parsedRequest);
  const defaultRequest = parseCheapestMoreSearchRequest(
    'them chuyen bay gia re',
  );

  if (!defaultRequest) {
    throw new Error('Expected cheapest follow-up request.');
  }

  const morningPatch = buildCheapestMoreSearchPatch(
    {
      searchInput: morningSearchInput,
      parsedRequest,
    },
    defaultRequest,
  );

  assert.equal(morningPatch.searchInput.preferredTime, 'morning');
  assert.equal(morningPatch.searchInput.resultRanking, 'cheapest');
  assert.equal(morningPatch.searchInput.resultLimit, 5);
  assert.equal(morningPatch.parsedRequest?.preferredTime, 'morning');
  assert.equal(morningPatch.parsedRequest?.resultRanking, 'cheapest');

  const afternoonRequest = parseCheapestMoreSearchRequest(
    '5 chuyen re nhat buoi chieu',
  );

  if (!afternoonRequest) {
    throw new Error('Expected afternoon cheapest follow-up request.');
  }

  const afternoonPatch = buildCheapestMoreSearchPatch(
    {
      searchInput: morningSearchInput,
      parsedRequest,
    },
    afternoonRequest,
  );

  assert.equal(afternoonPatch.searchInput.preferredTime, 'afternoon');
  assert.equal(afternoonPatch.searchInput.resultRanking, 'cheapest');
  assert.equal(afternoonPatch.searchInput.resultLimit, 5);

  const noBucketSearchInput = {
    ...morningSearchInput,
    preferredTime: undefined,
    resultRanking: null,
  };
  const noBucketPatch = buildCheapestMoreSearchPatch(
    {
      searchInput: noBucketSearchInput,
      parsedRequest: undefined,
    },
    defaultRequest,
  );

  assert.equal(noBucketPatch.searchInput.preferredTime, null);
  assert.equal(noBucketPatch.searchInput.resultRanking, 'cheapest');
  assert.equal(noBucketPatch.parsedRequest, undefined);

  const nightSearchInput = {
    ...morningSearchInput,
    preferredTime: 'night',
    resultRanking: 'cheapest',
    resultLimit: 10,
  } as const;
  const earlyMorningRequest = parseCheapestMoreSearchRequest(
    'them chuyen gia re vao sang som',
  );

  if (!earlyMorningRequest) {
    throw new Error('Expected early-morning cheapest follow-up request.');
  }

  const earlyMorningPatch = buildCheapestMoreSearchPatch(
    {
      searchInput: nightSearchInput,
      parsedRequest,
    },
    earlyMorningRequest,
  );

  assert.equal(earlyMorningPatch.searchInput.preferredTime, 'early_morning');
  assert.equal(earlyMorningPatch.searchInput.resultLimit, 5);
}

/**
 * Verifies plain "need more" wording opens the bucket menu for a saved case.
 */
function testCheapestMoreOptionsMenuEligibility() {
  const parsedRequest = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    preferredTime: null,
    resultRanking: null,
  });
  const searchInput = mapParsedRequestToSearchFlightsInput(parsedRequest);

  assert.equal(looksLikeMoreCheapestOptionsRequest('toi can them'), true);
  assert.equal(looksLikeMoreCheapestOptionsRequest('them chuyen bay'), true);
  assert.equal(looksLikeMoreCheapestOptionsRequest('5 chuyen bay'), true);
  assert.equal(
    looksLikeMoreCheapestOptionsRequest('them chuyen bay gia re'),
    false,
  );
  assert.equal(
    looksLikeMoreCheapestOptionsRequest('minh muon bay tu SGN ra HAN ngay 30/07'),
    false,
  );
  assert.equal(
    canShowCheapestMoreOptionsForCase({
      searchInput,
    }),
    true,
  );
  assert.equal(canShowCheapestMoreOptionsForCase({}), false);
}

/**
 * Verifies normal follow-ups stay out of the cheapest lane and clear stale
 * cheapest ranking before rerunning the latest case.
 */
function testNormalFlightFollowUpPatch() {
  assert.deepEqual(parseNormalFlightFollowUpRequest('them chuyen bay'), {});
  assert.deepEqual(parseNormalFlightFollowUpRequest('toi can them'), {});
  assert.deepEqual(parseNormalFlightFollowUpRequest('5 chuyen bay'), {});
  assert.deepEqual(parseNormalFlightFollowUpRequest('buoi toi'), {
    preferredTime: 'night',
    bucketLabel: 'bu\u1ed5i t\u1ed1i',
  });
  assert.deepEqual(parseNormalFlightFollowUpRequest('5 chuyen bay buoi chieu'), {
    preferredTime: 'afternoon',
    bucketLabel: 'bu\u1ed5i chi\u1ec1u',
  });
  assert.equal(
    parseNormalFlightFollowUpRequest('them chuyen bay gia re'),
    null,
  );

  const parsedRequest = ParsedFlightRequestSchema.parse({
    ...validOneWayRequest,
    preferredTime: 'morning',
    resultRanking: 'cheapest',
  });
  const searchInput = {
    ...mapParsedRequestToSearchFlightsInput(parsedRequest),
    resultLimit: 10,
  } as const;
  const nightRequest = parseNormalFlightFollowUpRequest('buoi toi');

  if (!nightRequest) {
    throw new Error('Expected normal night follow-up request.');
  }

  const normalPatch = buildNormalBucketSearchPatch(
    {
      searchInput,
      parsedRequest,
    },
    nightRequest,
  );

  assert.equal(normalPatch.searchInput?.preferredTime, 'night');
  assert.equal(normalPatch.searchInput?.resultRanking, null);
  assert.equal(normalPatch.searchInput?.resultLimit, undefined);
  assert.equal(normalPatch.parsedRequest?.preferredTime, 'night');
  assert.equal(normalPatch.parsedRequest?.resultRanking, null);
}
/**
 * Verifies Telegram flight failures use retry patterns instead of raw internals.
 */
function testOperatorFriendlyFlightFailureMessages() {
  const missingSearchMessage = formatMissingFlightFieldsMessage([
    'fromAirportCode',
    'toAirportCode',
    'departureDate',
  ]);
  const selectionParseMessage = formatFlightSelectionParseFailedMessage([
    'departureTime',
  ]);
  const selectionNoMatchMessage = formatFlightSelectionFailedMessage(
    'No available flight matched VJ 05:00 ECO.',
    {
      caseId: 'BK-20260605-095859',
      airlineCode: 'VJ',
      airlineName: 'Vietjet Air',
      departureTime: '05:00',
      bookingClass: 'ECO',
    },
  );
  const searchFailedMessage = formatSearchFailedMessage(
    'page.waitForFunction: Timeout 10000ms exceeded.',
  );
  const mappingFailedMessage = formatSearchInputMappingFailedMessage();
  const combinedText = [
    missingSearchMessage,
    selectionParseMessage,
    selectionNoMatchMessage,
    searchFailedMessage,
    mappingFailedMessage,
  ].join('\n');

  assert.match(missingSearchMessage, /bay từ SGN ra HAN ngày 30\/07/);
  assert.match(selectionParseMessage, /chọn chuyến Vietjet 22:15/);
  assert.match(selectionParseMessage, /đặt chuyến VJ 22:15/);
  assert.match(selectionParseMessage, /BK-YYYYMMDD-HHMMSS chọn VJ 22:15 hạng Eco/);
  assert.match(selectionNoMatchMessage, /Hãng: Vietjet Air \(VJ\)/);
  assert.match(selectionNoMatchMessage, /Giờ bay: 05:00/);
  assert.match(selectionNoMatchMessage, /Hạng: Eco \(ECO\)/);
  assert.match(selectionNoMatchMessage, /chọn chuyến Vietjet Air 05:00 hạng Deluxe/);
  assert.doesNotMatch(
    combinedText,
    /No available flight matched|Missing fields:|fromAirportCode|toAirportCode|departureDate\b|departureTime|page\.waitForFunction|OPENAI_API_KEY/i,
  );
}

/**
 * Verifies fixed Vietnam time buckets and top-cheapest result ranking.
 */
function testFlightResultRanking() {
  const candidates: FlightResultCandidate[] = [
    createRankingCandidate(0, '05:59', 900000),
    createRankingCandidate(1, '06:00', 700000),
    createRankingCandidate(2, '07:30', 500000),
    createRankingCandidate(3, '08:30', 600000),
    createRankingCandidate(4, '09:30', 800000),
    createRankingCandidate(5, '11:59', 550000),
    createRankingCandidate(6, '12:00', 300000),
    createRankingCandidate(7, '17:59', 400000),
    createRankingCandidate(8, '18:00', 200000),
    createRankingCandidate(9, '20:00', 950000),
  ];

  assert.equal(isFlightTimeInBucket('05:59', 'early_morning'), true);
  assert.equal(isFlightTimeInBucket('06:00', 'morning'), true);
  assert.equal(isFlightTimeInBucket('11:59', 'morning'), true);
  assert.equal(isFlightTimeInBucket('12:00', 'afternoon'), true);
  assert.equal(isFlightTimeInBucket('17:59', 'afternoon'), true);
  assert.equal(isFlightTimeInBucket('18:00', 'night'), true);
  assert.equal(getFlightTimeBucketForPreferredTime('specific_time'), null);

  const normalMorning = selectFlightResultsForSearch({
    candidates,
    preferredTime: 'morning',
    resultRanking: null,
  });

  assert.deepEqual(
    normalMorning?.candidates.map((candidate) => candidate.cardIndex),
    [1, 2, 3, 4, 5],
  );
  assert.equal(normalMorning?.summary.ranking, null);
  assert.equal(normalMorning?.summary.displayedCount, 5);
  assert.equal(normalMorning?.summary.totalVisibleCount, 10);

  const normalNight = selectFlightResultsForSearch({
    candidates,
    preferredTime: 'night',
    resultRanking: null,
  });

  assert.deepEqual(
    normalNight?.candidates.map((candidate) => candidate.cardIndex),
    [8, 9],
  );

  const normalMissingSpecificTime = selectFlightResultsForSearch({
    candidates,
    preferredTime: 'specific_time',
    specificTime: null,
    resultRanking: null,
  });

  assert.equal(normalMissingSpecificTime, null);

  const specificWindowFilter = resolveFlightTimeFilter({
    preferredTime: 'specific_time',
    specificTime: '17:00',
  });

  assert.equal(specificWindowFilter?.kind, 'specific_window');
  assert.equal(specificWindowFilter?.label, 'gần 17:00 (15:00-19:00)');
  assert.equal(
    resolveFlightTimeFilter({
      preferredTime: 'specific_time',
      specificTime: '01:00',
    })?.label,
    'gần 01:00 (00:00-03:00)',
  );
  assert.equal(
    resolveFlightTimeFilter({
      preferredTime: 'specific_time',
      specificTime: '23:00',
    })?.label,
    'gần 23:00 (21:00-23:59)',
  );

  const specificTimeCandidates: FlightResultCandidate[] = [
    createRankingCandidate(20, '14:59', 900000),
    createRankingCandidate(21, '15:00', 700000),
    createRankingCandidate(22, '17:00', 500000),
    createRankingCandidate(23, '19:00', 600000),
    createRankingCandidate(24, '19:01', 800000),
  ];
  const normalSpecificTime = selectFlightResultsForSearch({
    candidates: specificTimeCandidates,
    preferredTime: 'specific_time',
    specificTime: '17:00',
    resultRanking: null,
  });

  assert.deepEqual(
    normalSpecificTime?.candidates.map((candidate) => candidate.cardIndex),
    [21, 22, 23],
  );
  assert.equal(normalSpecificTime?.summary.requestedSpecificTime, '17:00');
  assert.equal(
    normalSpecificTime?.summary.requestedTimeWindowLabel,
    'gần 17:00 (15:00-19:00)',
  );

  const cheapestSpecificTime = rankFlightResultsForSearch({
    candidates: specificTimeCandidates,
    preferredTime: 'specific_time',
    specificTime: '17:00',
    resultRanking: 'cheapest',
  });

  assert.deepEqual(
    cheapestSpecificTime?.candidates.map((candidate) => candidate.cardIndex),
    [22, 23, 21],
  );

  const morningCheapest = rankFlightResultsForSearch({
    candidates,
    preferredTime: 'morning',
    resultRanking: 'cheapest',
  });

  assert.deepEqual(
    morningCheapest?.candidates.map((candidate) => candidate.cardIndex),
    [2, 5, 3, 1, 4],
  );
  assert.equal(morningCheapest?.summary.matchedCount, 5);
  assert.equal(morningCheapest?.summary.displayedCount, 5);

  const allCheapest = rankFlightResultsForSearch({
    candidates,
    preferredTime: null,
    resultRanking: 'cheapest',
  });

  assert.deepEqual(
    allCheapest?.candidates.map((candidate) => candidate.cardIndex),
    [8, 6, 7, 2, 5],
  );

  const allCheapestTen = rankFlightResultsForSearch({
    candidates,
    preferredTime: null,
    resultRanking: 'cheapest',
    limit: 10,
  });

  assert.deepEqual(
    allCheapestTen?.candidates.map((candidate) => candidate.cardIndex),
    [8, 6, 7, 2, 5, 3, 1, 4, 0, 9],
  );
  assert.equal(allCheapestTen?.summary.displayedCount, 10);

  const emptyBucket = rankFlightResultsForSearch({
    candidates: [createRankingCandidate(10, '14:10', 450000)],
    preferredTime: 'early_morning',
    resultRanking: 'cheapest',
  });

  assert.equal(emptyBucket?.summary.displayedCount, 0);
  assert.equal(emptyBucket?.summary.matchedCount, 0);

  const emptyNormalBucket = selectFlightResultsForSearch({
    candidates: [createRankingCandidate(10, '14:10', 450000)],
    preferredTime: 'early_morning',
    resultRanking: null,
  });

  assert.equal(emptyNormalBucket?.summary.displayedCount, 0);
  assert.equal(emptyNormalBucket?.summary.matchedCount, 0);

  const normalBucketMessage = formatSearchSuccessMessage(
    10,
    normalMorning?.summary,
  );

  assert.match(normalBucketMessage, /5 chuyến trong khung/i);
  assert.match(normalBucketMessage, /Tổng kết quả live: 10 chuyến/i);
  assert.equal(
    extractLowestVndPriceAmount('VND 1,832,520\nVND 1,616,520'),
    1616520,
  );
}

/**
 * Verifies 1Booking card parsing keeps raw fare codes across MVP airlines.
 */
function testFlightCardParserSupportsMvpAirlines() {
  const vietjet = parseFlightCardText(
    0,
    'Vietjet Air VJ136 A321 12:00 SGN 14:10 HAN VND 1,642,781 (Z1_ECO)',
  );
  const bamboo = parseFlightCardText(
    1,
    'Bamboo Airways QH204 A320 07:10 SGN 09:20 HAN VND 2,918,000 (N)',
  );
  const vietravel = parseFlightCardText(
    2,
    'Vietravel Airlines VU635 A321 06:25 HAN 07:50 DAD VND 1,923,240 (H)',
  );
  const sunPhuQuoc = parseFlightCardText(
    3,
    'Sun Phu Quoc Airways 9S622 A320 19:00 SGN 20:20 DAD VND 1,480,781 (B)',
  );
  const vietnamAirlines = parseFlightCardText(
    4,
    'Vietnam Airlines VN212 B787 12:00 SGN 14:10 HAN VND 2,492,181 (N)',
  );

  assert.equal(vietjet?.bookingClass, 'ECO');
  assert.equal(vietjet?.rawBookingClassCode, 'Z1_ECO');
  assert.equal(bamboo?.bookingClass, null);
  assert.equal(bamboo?.rawBookingClassCode, 'N');
  assert.equal(vietravel?.rawBookingClassCode, 'H');
  assert.equal(sunPhuQuoc?.rawBookingClassCode, 'B');
  assert.equal(vietnamAirlines?.airlineCode, 'VN');
  assert.equal(vietnamAirlines?.bookingClass, null);
  assert.equal(vietnamAirlines?.rawBookingClassCode, 'N');
}

function createRankingCandidate(
  cardIndex: number,
  departureTime: string,
  priceAmount: number,
): FlightResultCandidate {
  return {
    cardIndex,
    airlineCode: 'VJ',
    airlineName: 'Vietjet Air',
    flightNumber: `VJ${120 + cardIndex}`,
    departureTime,
    arrivalTime: null,
    bookingClass: 'ECO',
    rawBookingClassCode: 'Z1_ECO',
    priceText: `VND ${priceAmount}`,
    priceAmount,
  };
}

/**
 * Verifies that matcher uses booking class only when explicitly requested.
 */
function testFlightSelectionMatcher() {
  const candidates = [
    {
      cardIndex: 0,
      airlineCode: 'VJ',
      airlineName: 'Vietjet Air',
      flightNumber: 'VJ120',
      departureTime: '05:00',
      arrivalTime: '07:10',
      bookingClass: 'DLX',
      rawBookingClassCode: 'W1_DLX',
      priceText: 'VND 2,322,200',
    },
    {
      cardIndex: 1,
      airlineCode: 'VJ',
      airlineName: 'Vietjet Air',
      flightNumber: 'VJ124',
      departureTime: '06:05',
      arrivalTime: '08:15',
      bookingClass: 'ECO',
      rawBookingClassCode: 'U1_ECO',
      priceText: 'VND 2,322,200',
    },
  ] as const;

  const match = matchFlightSelectionCandidate([...candidates], {
    caseId: 'BK-20260520-155949',
    airlineCode: 'VJ',
    airlineName: 'Vietjet Air',
    departureTime: '05:00',
    bookingClass: null,
  });

  assert.equal(match.ok, true);

  if (match.ok) {
    assert.equal(match.candidate.flightNumber, 'VJ120');
  }

  const noMatch = matchFlightSelectionCandidate([...candidates], {
    caseId: 'BK-20260520-155949',
    airlineCode: 'VJ',
    airlineName: 'Vietjet Air',
    departureTime: '05:00',
    bookingClass: 'ECO',
  });

  assert.equal(noMatch.ok, false);

  const timeOnlyMatch = matchFlightSelectionCandidate([...candidates], {
    caseId: 'BK-20260520-155949',
    airlineCode: null,
    airlineName: null,
    departureTime: '06:05',
    bookingClass: null,
  });

  assert.equal(timeOnlyMatch.ok, true);

  const nonVietjetMatch = matchFlightSelectionCandidate(
    [
      {
        cardIndex: 2,
        airlineCode: 'QH',
        airlineName: 'Bamboo Airways',
        flightNumber: 'QH204',
        departureTime: '07:10',
        arrivalTime: '09:20',
        bookingClass: null,
        rawBookingClassCode: 'N',
        priceText: 'VND 2,918,000',
      },
    ],
    {
      caseId: 'BK-20260520-155949',
      airlineCode: 'QH',
      airlineName: 'Bamboo Airways',
      departureTime: '07:10',
      bookingClass: null,
    },
  );

  assert.equal(nonVietjetMatch.ok, true);

  const ambiguousTimeOnlyMatch = matchFlightSelectionCandidate(
    [
      ...candidates,
      {
        cardIndex: 2,
        airlineCode: 'VN',
        airlineName: 'Vietnam Airlines',
        flightNumber: 'VN124',
        departureTime: '06:05',
        arrivalTime: '08:15',
        bookingClass: null,
        rawBookingClassCode: 'N',
        priceText: 'VND 2,422,200',
      },
    ],
    {
      caseId: 'BK-20260520-155949',
      airlineCode: null,
      airlineName: null,
      departureTime: '06:05',
      bookingClass: null,
    },
  );

  assert.equal(ambiguousTimeOnlyMatch.ok, false);

  if (!ambiguousTimeOnlyMatch.ok) {
    assert.equal(ambiguousTimeOnlyMatch.reason, 'multiple_matches');
  }
}

/**
 * Verifies that the auth waiter catches 1Booking API 498 expired-session UI.
 */
async function testOneBookingAuthExpiredToastDetection() {
  const fakePage = {
    async waitForTimeout() {
      return null;
    },
    locator(selector: string) {
      if (selector === 'input[type="password"]') {
        return {
          first() {
            return {
              async isVisible() {
                return false;
              },
            };
          },
        };
      }

      return {
        async innerText() {
          return 'Lỗi 498 Phiên đăng nhập đã hết hạn';
        },
      };
    },
  };

  await assert.rejects(
    () => throwIfOneBookingLoginModalVisible(fakePage as never, 0),
    (error) =>
      error instanceof OneBookingAuthExpiredError &&
      /auth session expired/.test(error.message),
  );
}

/**
 * Verifies that the auth waiter still catches the direct password modal.
 */
async function testOneBookingAuthExpiredPasswordModalDetection() {
  const fakePage = {
    async waitForTimeout() {
      return null;
    },
    locator(selector: string) {
      if (selector === 'input[type="password"]') {
        return {
          first() {
            return {
              async isVisible() {
                return true;
              },
            };
          },
        };
      }

      return {
        async innerText() {
          return '';
        },
      };
    },
  };

  await assert.rejects(
    () => throwIfOneBookingLoginModalVisible(fakePage as never, 0),
    (error) =>
      error instanceof OneBookingAuthExpiredError &&
      /auth session expired/.test(error.message),
  );
}

/**
 * Verifies that the optional 1Booking notice drawer is closed when visible.
 */
async function testOneBookingImportantNoticeDrawerClose() {
  let closeClicked = false;
  let escapePressed = false;

  const fakeHeading = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async waitFor() {
      return null;
    },
  };
  const fakeCloseTarget = {
    first() {
      return this;
    },
    last() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async click() {
      closeClicked = true;
    },
  };
  const fakeDrawer = {
    filter() {
      return this;
    },
    last() {
      return this;
    },
    locator() {
      return fakeCloseTarget;
    },
    getByRole() {
      return fakeCloseTarget;
    },
  };
  const fakePage = {
    getByText() {
      return fakeHeading;
    },
    locator(selector: string) {
      if (selector.includes('ant-drawer-close')) {
        return fakeCloseTarget;
      }

      return fakeDrawer;
    },
    keyboard: {
      async press() {
        escapePressed = true;
      },
    },
  };

  const didClose = await closeOneBookingImportantNoticeDrawer(
    fakePage as never,
    0,
  );

  assert.equal(didClose, true);
  assert.equal(closeClicked, true);
  assert.equal(escapePressed, false);
}

/**
 * Verifies automatic 1Booking login credential validation before browser launch.
 */
function testOneBookingCredentialValidation() {
  assert.deepEqual(
    readOneBookingCredentialsFromEnv({
      ONE_BOOKING_AGENT_ID: 'HS0001',
      ONE_BOOKING_USERNAME: 'operator',
      ONE_BOOKING_PASSWORD: 'secret',
    }),
    {
      agentId: 'HS0001',
      username: 'operator',
      password: 'secret',
    },
  );
  assert.throws(
    () =>
      readOneBookingCredentialsFromEnv({
        ONE_BOOKING_AGENT_ID: 'HS0001',
        ONE_BOOKING_USERNAME: '',
        ONE_BOOKING_PASSWORD: 'secret',
      }),
    (error) =>
      error instanceof OneBookingAuthRefreshError &&
      /ONE_BOOKING_USERNAME/.test(error.message) &&
      !/secret/.test(error.message),
  );
}

/**
 * Verifies that parser provider selection defaults to mock and supports openai.
 */
function testParserFactoryProviderSelection() {
  const previousProvider = process.env.FLIGHT_PARSER_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;

  try {
    delete process.env.FLIGHT_PARSER_PROVIDER;
    assert.equal(getFlightParserProvider(), 'mock');
    assert.equal(typeof createFlightRequestParser().parse, 'function');

    process.env.FLIGHT_PARSER_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-api-key';
    assert.equal(getFlightParserProvider(), 'openai');
    assert.equal(typeof createFlightRequestParser().parse, 'function');
  } finally {
    if (previousProvider === undefined) {
      delete process.env.FLIGHT_PARSER_PROVIDER;
    } else {
      process.env.FLIGHT_PARSER_PROVIDER = previousProvider;
    }

    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
}

/**
 * Verifies that invalid OpenAI structured output becomes a clear parser error.
 */
async function testOpenAIParserRejectsInvalidOutput() {
  const parser = createOpenAIFlightRequestParser({
    model: 'test-model',
    today: '2026-05-19',
    client: {
      chat: {
        completions: {
          async parse() {
            return {
              choices: [
                {
                  message: {
                    content: 'not-json',
                    parsed: null,
                  },
                },
              ],
            };
          },
        },
      },
    },
  });

  await assert.rejects(
    () => parser.parse('Khach muon bay Ha Noi vao Sai Gon ngay mai'),
    /invalid structured output/,
  );
}

/**
 * Verifies that OpenAI parser setup fails clearly when API key is missing.
 */
function testOpenAIParserRequiresApiKey() {
  const previousApiKey = process.env.OPENAI_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;

    assert.throws(
      () => createOpenAIFlightRequestParser(),
      /Missing OPENAI_API_KEY/,
    );
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
}

async function main() {
  testValidOneWaySchema();
  testRoundTripRequiresReturnDate();
  testMapperRejectsMissingFields();
  testMapperCanonicalizesAirportText();
  testMapperResolvesAirportTextFallback();
  testParsedAirportNormalizationBeforeMissingFieldCheck();
  testAirportCatalogAliases();
  testOpenAIParserPromptIncludesAirportCatalog();
  testFlightTimeBucketAndRankingSchema();
  testVietnameseSpecificTimeNormalization();
  testAirportCatalogCodeLookup();
  testFlightSelectionParserLeavesBookingClassUnspecified();
  testFlightSelectionParserBookingClassAliases();
  testFlightSelectionParserRejectsMissingFields();
  testFlightSelectionParserUsesLatestCaseContext();
  testFlightSelectionParserUsesImplicitLatestCaseContext();
  testFlightSelectionParserAcceptsNaturalChooseAlias();
  testFlightSelectionParserRequiresContextForImplicitLatestCase();
  testFlightSelectionParserDoesNotClaimSearchRequest();
  testFlightSelectionParserAcceptsCombinedPassengerMessage();
  testFlightSelectionParserRequiresLatestCaseContext();
  testLatestFlightSearchCaseContext();
  testCheapestBucketFollowUpPatch();
  testCheapestMoreSearchPatch();
  testCheapestMoreOptionsMenuEligibility();
  testNormalFlightFollowUpPatch();
  testOperatorFriendlyFlightFailureMessages();
  testFlightResultRanking();
  testFlightCardParserSupportsMvpAirlines();
  testFlightSelectionMatcher();
  await testOneBookingAuthExpiredToastDetection();
  await testOneBookingAuthExpiredPasswordModalDetection();
  await testOneBookingImportantNoticeDrawerClose();
  testOneBookingCredentialValidation();
  testParserFactoryProviderSelection();
  testOpenAIParserRequiresApiKey();
  await testOpenAIParserRejectsInvalidOutput();

  console.log('Flight parser contract tests passed.');
}

main().catch((error) => {
  console.error('Flight parser contract tests failed:', error);
  process.exit(1);
});
