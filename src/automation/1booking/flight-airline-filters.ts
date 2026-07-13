import {
  getAirlineNamesByCodes,
  normalizePreferredAirlineCodes,
} from '../../agent/airline-catalog';
import { type FlightResultCandidate } from './flight-result-types';

export type FlightAirlineFilter = {
  codes: string[];
  names: string[];
};

/**
 * Resolves optional requested airline codes into a display-ready filter.
 */
export function resolveFlightAirlineFilter(
  preferredAirlineCodes?: string[] | null,
): FlightAirlineFilter | null {
  const codes = normalizePreferredAirlineCodes(preferredAirlineCodes);

  if (!codes) {
    return null;
  }

  return {
    codes,
    names: getAirlineNamesByCodes(codes),
  };
}

/**
 * Applies the requested airline filter while preserving 1Booking result order.
 */
export function selectCandidatesByAirlineFilter(input: {
  candidates: FlightResultCandidate[];
  airlineFilter: FlightAirlineFilter | null;
}) {
  if (!input.airlineFilter) {
    return input.candidates;
  }

  const allowedCodes = new Set(input.airlineFilter.codes);

  return input.candidates.filter((candidate) =>
    allowedCodes.has(candidate.airlineCode),
  );
}
