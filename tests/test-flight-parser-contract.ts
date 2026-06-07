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
  OneBookingAuthExpiredError,
  throwIfOneBookingLoginModalVisible,
} from '../src/automation/1booking/waiters';
import { ParsedFlightRequestSchema } from '../src/contracts/flight';
import {
  getLatestFlightSearchCase,
  setLatestFlightSearchCase,
} from '../src/telegram/telegram-flight-selection-context';

const validOneWayRequest = {
  fromAirportCode: 'HAN',
  fromAirportText: 'San bay Noi Bai (HAN)',
  toAirportCode: 'SGN',
  toAirportText: 'San bay Tan Son Nhat (SGN)',
  departureDate: '2026-05-20',
  returnDate: null,
  preferredTime: 'morning',
  specificTime: null,
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
        bookingClass: 'DLX',
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
  testAirportCatalogCodeLookup();
  testFlightSelectionParserLeavesBookingClassUnspecified();
  testFlightSelectionParserBookingClassAliases();
  testFlightSelectionParserRejectsMissingFields();
  testFlightSelectionParserUsesLatestCaseContext();
  testFlightSelectionParserAcceptsCombinedPassengerMessage();
  testFlightSelectionParserRequiresLatestCaseContext();
  testLatestFlightSearchCaseContext();
  testFlightSelectionMatcher();
  await testOneBookingAuthExpiredToastDetection();
  await testOneBookingAuthExpiredPasswordModalDetection();
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
