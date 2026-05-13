import { type ParsedFlightRequest } from './parsed-flight-request';

export type SearchFlightInputValidation = {
  valid: boolean;
  missingFields: string[];
};

export type AutomationSupportValidation = {
  supported: boolean;
  reason: string | null;
};

/**
 * Checks if the parsed request has enough information to search flights.
 *
 * Current MVP:
 * - Supports one-way search first.
 * - Round-trip is recognized and stored, but may be blocked until automation
 *   supports it.
 */
export function validateSearchFlightInput(
  parsed: ParsedFlightRequest,
): SearchFlightInputValidation {
  const missingFields: string[] = [];

  if (!parsed.fromAirportCode) missingFields.push('fromAirportCode');
  if (!parsed.fromAirportText) missingFields.push('fromAirportText');
  if (!parsed.toAirportCode) missingFields.push('toAirportCode');
  if (!parsed.toAirportText) missingFields.push('toAirportText');
  if (!parsed.departureDate) missingFields.push('departureDate');

  if (parsed.tripType === 'round_trip' && !parsed.returnDate) {
    missingFields.push('returnDate');
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Checks whether the current automation version supports the parsed trip type.
 *
 * MVP v1 supports one-way search only. Round-trip parsing is supported for
 * future compatibility, but automation returns a clear message instead of
 * running an unsupported flow.
 */
export function validateAutomationSupport(
  parsed: ParsedFlightRequest,
): AutomationSupportValidation {
  if (parsed.tripType === 'round_trip') {
    return {
      supported: false,
      reason:
        'MVP hiện tại đã nhận diện được chuyến khứ hồi, nhưng automation tìm chuyến khứ hồi chưa được bật.',
    };
  }

  return {
    supported: true,
    reason: null,
  };
}
