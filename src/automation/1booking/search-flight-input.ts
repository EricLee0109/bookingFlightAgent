import {
  type FlightResultRanking,
  type ParsedFlightRequest,
  type PreferredTime,
  validateAutomationSupport,
  validateSearchFlightInput,
} from '../../contracts/flight';
import { normalizePreferredAirlineCodes } from '../../agent/airline-catalog';
import { formatIsoDateForOneBooking } from './dates';

/**
 * Validated input for the current 1Booking search automation.
 *
 * This component defines the browser-flow contract only. Raw AI output must be
 * parsed and validated before it is mapped into this type.
 */
export type SearchFlightsInput = {
  fromAirportCode: string | null;
  fromAirportText: string | null;
  toAirportCode: string | null;
  toAirportText: string | null;
  departureDate: string | null;
  preferredTime?: PreferredTime;
  specificTime?: string | null;
  resultRanking?: FlightResultRanking;
  resultLimit?: 5 | 10;
  preferredAirlineCodes?: string[] | null;
};

export type SearchFlightsInputValidation = {
  valid: boolean;
  missingFields: string[];
};

export type SearchFlightsInputMapResult =
  | {
      ok: true;
      input: SearchFlightsInput;
    }
  | {
      ok: false;
      reason: string;
      missingFields: string[];
    };

/**
 * Validates the final automation input before Playwright touches 1Booking.
 *
 * This protects production callers even when TypeScript is bypassed or a caller
 * accidentally builds the input object by hand.
 */
export function validateSearchFlightsAutomationInput(
  input: Partial<SearchFlightsInput>,
): SearchFlightsInputValidation {
  const missingFields: string[] = [];

  if (!input.fromAirportCode) missingFields.push('fromAirportCode');
  if (!input.fromAirportText) missingFields.push('fromAirportText');
  if (!input.toAirportCode) missingFields.push('toAirportCode');
  if (!input.toAirportText) missingFields.push('toAirportText');
  if (!input.departureDate) missingFields.push('departureDate');

  if (input.departureDate) {
    try {
      formatIsoDateForOneBooking(input.departureDate);
    } catch {
      missingFields.push('departureDate:YYYY-MM-DD');
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Throws a clear error when automation input is incomplete or malformed.
 *
 * `searchFlights()` calls this before any browser action, keeping validation
 * inside the automation boundary instead of trusting every caller.
 */
export function assertSearchFlightsAutomationInput(
  input: Partial<SearchFlightsInput>,
): asserts input is SearchFlightsInput {
  const validation = validateSearchFlightsAutomationInput(input);

  if (!validation.valid) {
    throw new Error(
      `Cannot run 1Booking search. Missing or invalid fields: ${validation.missingFields.join(', ')}`,
    );
  }
}

/**
 * Maps a validated parsed Telegram flight request into 1Booking automation input.
 *
 * This is the only bridge from AI/parser data to Playwright data. It blocks
 * missing fields and unsupported round-trip automation before browser work starts.
 */
export function mapParsedFlightRequestToSearchFlightsInput(
  parsed: ParsedFlightRequest,
): SearchFlightsInputMapResult {
  const inputValidation = validateSearchFlightInput(parsed);

  if (!inputValidation.valid) {
    return {
      ok: false,
      reason: 'Missing required flight search fields.',
      missingFields: inputValidation.missingFields,
    };
  }

  const supportValidation = validateAutomationSupport(parsed);

  if (!supportValidation.supported) {
    return {
      ok: false,
      reason: supportValidation.reason ?? 'This trip type is not supported yet.',
      missingFields: [],
    };
  }

  return {
    ok: true,
    input: {
      fromAirportCode: parsed.fromAirportCode,
      fromAirportText: parsed.fromAirportText,
      toAirportCode: parsed.toAirportCode,
      toAirportText: parsed.toAirportText,
      departureDate: parsed.departureDate,
      preferredTime: parsed.preferredTime,
      specificTime: parsed.specificTime,
      resultRanking: parsed.resultRanking,
      preferredAirlineCodes: normalizePreferredAirlineCodes(
        parsed.preferredAirlineCodes,
      ),
    },
  };
}
