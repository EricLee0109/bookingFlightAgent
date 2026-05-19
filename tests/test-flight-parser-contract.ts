import assert from 'node:assert/strict';
import { mapParsedRequestToSearchFlightsInput } from '../src/agent/search-flight-input-mapper';
import {
  createFlightRequestParser,
  getFlightParserProvider,
} from '../src/agent/flight-request-parser-factory';
import { createOpenAIFlightRequestParser } from '../src/agent/openai-flight-request-parser';
import { ParsedFlightRequestSchema } from '../src/contracts/flight';

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
  testParserFactoryProviderSelection();
  testOpenAIParserRequiresApiKey();
  await testOpenAIParserRejectsInvalidOutput();

  console.log('Flight parser contract tests passed.');
}

main().catch((error) => {
  console.error('Flight parser contract tests failed:', error);
  process.exit(1);
});
