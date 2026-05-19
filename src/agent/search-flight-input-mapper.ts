import { type SearchFlightsInput } from '../automation/1booking/flight-search';
import {
  validateAutomationSupport,
  validateSearchFlightInput,
  type ParsedFlightRequest,
} from '../contracts/flight';
import { resolveAirportByCode } from './airport-resolver';

/**
 * Converts a parsed flight request into the exact input shape required by
 * the 1Booking Playwright search flow.
 *
 * Why this exists:
 * - If required fields are missing, it throws a clear error before automation starts.
 * - We should never pass raw AI output directly into Browser Automation.
 * - This mapper acts as a safety boundary between Agent logic and Playwright.
 */
export function mapParsedRequestToSearchFlightsInput(
  parsed: ParsedFlightRequest,
): SearchFlightsInput {
  const automationSupport = validateAutomationSupport(parsed);

  if (!automationSupport.supported) {
    throw new Error(
      automationSupport.reason ??
        'Cannot map parsed request to SearchFlightsInput. Unsupported automation flow.',
    );
  }

  const validation = validateSearchFlightInput(parsed);

  if (!validation.valid) {
    throw new Error(
      `Cannot map parsed request to SearchFlightsInput. Missing fields: ${validation.missingFields.join(
        ', ',
      )}`,
    );
  }

  const {
    fromAirportCode,
    fromAirportText,
    toAirportCode,
    toAirportText,
    departureDate,
  } = parsed;

  if (
    !fromAirportCode ||
    !fromAirportText ||
    !toAirportCode ||
    !toAirportText ||
    !departureDate
  ) {
    throw new Error(
      'Cannot map parsed request to SearchFlightsInput. Parsed request is incomplete.',
    );
  }

  const fromAirport = resolveAirportByCode(fromAirportCode);
  const toAirport = resolveAirportByCode(toAirportCode);

  if (!fromAirport || !toAirport) {
    throw new Error(
      `Cannot map parsed request to SearchFlightsInput. Unsupported airport code(s): ${[
        !fromAirport ? fromAirportCode : null,
        !toAirport ? toAirportCode : null,
      ]
        .filter(Boolean)
        .join(', ')}`,
    );
  }

  return {
    fromAirportCode: fromAirport.code,
    fromAirportText: fromAirport.text,
    toAirportCode: toAirport.code,
    toAirportText: toAirport.text,
    departureDate,
  };
}
