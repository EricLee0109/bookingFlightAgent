import { type ParsedFlightRequest } from '../contracts/flight';

/**
 * Parser contract for turning operator text into a structured flight request.
 *
 * The MVP uses a mock parser now. A future AI parser must keep this boundary so
 * Telegram transport, validation, mapping, and automation logic do not change.
 */
export type FlightRequestParser = {
  parse(rawMessage: string): Promise<ParsedFlightRequest>;
};
