import { type SearchFlightsInput } from '../automation/1booking/flight-search';
import { type ParsedFlightRequest } from './flight-request-schema';

/**
 * Converts a parsed flight request into the exact input shape required by
 * the 1Booking Playwright search flow.
 *
 * Why this exists:
 * - We should never pass raw AI output directly into Browser Automation.
 * - This mapper acts as a safety boundary between Agent logic and Playwright.
 * - If required fields are missing, it throws a clear error before automation starts.
 */
export function mapParsedRequestToSearchFlightsInput(
  parsed: ParsedFlightRequest,
): SearchFlightsInput {
  const missingFields: string[] = [];

  if (!parsed.fromAirportCode) missingFields.push('fromAirportCode');
  if (!parsed.fromAirportText) missingFields.push('fromAirportText');
  if (!parsed.toAirportCode) missingFields.push('toAirportCode');
  if (!parsed.toAirportText) missingFields.push('toAirportText');
  if (!parsed.departureDate) missingFields.push('departureDate');

  if (parsed.tripType === 'round_trip') {
    throw new Error(
      'Cannot map parsed request to SearchFlightsInput. Round-trip automation is not supported in MVP v0.',
    );
  }

  if (missingFields.length > 0) {
    throw new Error(
      `Cannot map parsed request to SearchFlightsInput. Missing fields: ${missingFields.join(
        ', ',
      )}`,
    );
  }

  return {
    fromAirportCode: parsed.fromAirportCode,
    fromAirportText: parsed.fromAirportText,
    toAirportCode: parsed.toAirportCode,
    toAirportText: parsed.toAirportText,
    departureDate: parsed.departureDate,
  };
}
