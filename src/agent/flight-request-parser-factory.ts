import { type FlightRequestParser } from './flight-request-parser';
import { mockFlightRequestParser } from './mock-flight-request-parser';
import { createOpenAIFlightRequestParser } from './openai-flight-request-parser';

export type FlightParserProvider = 'mock' | 'openai';

/**
 * Creates the configured flight request parser for the Telegram Agent.
 *
 * This factory keeps provider choice outside the Telegram transport layer so
 * mock and OpenAI parsers can be swapped without changing message handling.
 */
export function createFlightRequestParser(): FlightRequestParser {
  const provider = getFlightParserProvider();

  if (provider === 'openai') {
    return createOpenAIFlightRequestParser();
  }

  return mockFlightRequestParser;
}

/**
 * Reads and validates the parser provider from local environment config.
 */
export function getFlightParserProvider(): FlightParserProvider {
  const provider = process.env.FLIGHT_PARSER_PROVIDER ?? 'mock';

  if (provider === 'mock' || provider === 'openai') {
    return provider;
  }

  throw new Error(
    `Unsupported FLIGHT_PARSER_PROVIDER "${provider}". Use "mock" or "openai".`,
  );
}
