import {
  type FlightResultRanking,
  type PreferredTime,
} from '../../contracts/flight';
import { extractLowestVndPriceAmount, parseFlightCardText } from './flight-card-parser';
import {
  extractFlightResultCandidates,
  getFlightCards,
} from './flight-result-candidates';
import { buildFlightResultFilterSummary } from './flight-result-summary';
import {
  resolveFlightAirlineFilter,
  selectCandidatesByAirlineFilter,
} from './flight-airline-filters';
import {
  isFlightCandidateInTimeFilter,
  resolveFlightTimeFilter,
} from './flight-time-filters';
import {
  type FlightResultCandidate,
  type RankedFlightResult,
} from './flight-result-types';
import {
  FLIGHT_TIME_BUCKETS,
  getFlightTimeBucketForPreferredTime,
  isFlightTimeInBucket,
} from './flight-time-buckets';

const CHEAPEST_RESULT_LIMIT = 5;

/**
 * Selects customer-facing flight cards for screenshots.
 *
 * Normal searches preserve 1Booking order and only apply a requested time
 * bucket. Cheapest searches reuse that bucket first, then sort by price and
 * keep the requested top N cards.
 */
export function selectFlightResultsForSearch(input: {
  candidates: FlightResultCandidate[];
  preferredTime?: PreferredTime;
  specificTime?: string | null;
  resultRanking?: FlightResultRanking;
  limit?: number;
  preferredAirlineCodes?: string[] | null;
}): RankedFlightResult | null {
  const airlineFilter = resolveFlightAirlineFilter(input.preferredAirlineCodes);
  const timeFilter = resolveFlightTimeFilter({
    preferredTime: input.preferredTime,
    specificTime: input.specificTime,
  });

  if (!airlineFilter && !timeFilter && input.resultRanking !== 'cheapest') {
    return null;
  }

  const airlineScopedCandidates = selectCandidatesByAirlineFilter({
    candidates: input.candidates,
    airlineFilter,
  });
  const scopedCandidates = selectCandidatesByTimeFilter({
    candidates: airlineScopedCandidates,
    timeFilter,
  });
  const selectedCandidates =
    input.resultRanking === 'cheapest'
      ? selectCheapestCandidates(scopedCandidates, input.limit)
      : scopedCandidates;

  return {
    candidates: selectedCandidates,
    cardIndexes: selectedCandidates.map((candidate) => candidate.cardIndex),
    summary: buildFlightResultFilterSummary({
      ranking: input.resultRanking,
      airlineFilter,
      timeFilter,
      totalVisibleCount: input.candidates.length,
      scopedCandidates,
      selectedCandidates,
    }),
  };
}

/**
 * Backwards-compatible alias for callers/tests that still use the old name.
 */
export function rankFlightResultsForSearch(input: {
  candidates: FlightResultCandidate[];
  preferredTime?: PreferredTime;
  specificTime?: string | null;
  resultRanking?: FlightResultRanking;
  limit?: number;
  preferredAirlineCodes?: string[] | null;
}) {
  return selectFlightResultsForSearch(input);
}

function selectCandidatesByTimeFilter(input: {
  candidates: FlightResultCandidate[];
  timeFilter: ReturnType<typeof resolveFlightTimeFilter>;
}) {
  return input.timeFilter
    ? input.candidates.filter((candidate) =>
        isFlightCandidateInTimeFilter(candidate, input.timeFilter!),
      )
    : input.candidates;
}

/**
 * Sorts bucket-scoped candidates by lowest visible price for cheapest results.
 */
function selectCheapestCandidates(
  candidates: FlightResultCandidate[],
  limit?: number,
) {
  return candidates
    .filter((candidate) => candidate.priceAmount !== null)
    .sort(
      (left, right) =>
        (left.priceAmount ?? Number.MAX_SAFE_INTEGER) -
          (right.priceAmount ?? Number.MAX_SAFE_INTEGER) ||
        left.cardIndex - right.cardIndex,
    )
    .slice(0, limit ?? CHEAPEST_RESULT_LIMIT);
}

export {
  extractFlightResultCandidates,
  extractLowestVndPriceAmount,
  FLIGHT_TIME_BUCKETS,
  resolveFlightTimeFilter,
  getFlightCards,
  getFlightTimeBucketForPreferredTime,
  isFlightTimeInBucket,
  parseFlightCardText,
};
export type {
  FlightResultCandidate,
  FlightResultFilterSummary,
  FlightTimeBucket,
  RankedFlightResult,
} from './flight-result-types';
