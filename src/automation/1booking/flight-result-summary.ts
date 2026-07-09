import { type FlightResultRanking } from '../../contracts/flight';
import { formatVndAmount } from './flight-card-parser';
import { FLIGHT_TIME_BUCKETS } from './flight-time-buckets';
import {
  type FlightResultCandidate,
  type FlightResultFilterSummary,
  type FlightTimeBucket,
} from './flight-result-types';

export type FlightResultSummaryInput = {
  ranking?: FlightResultRanking;
  requestedTimeBucket: FlightTimeBucket | null;
  totalVisibleCount: number;
  scopedCandidates: FlightResultCandidate[];
  selectedCandidates: FlightResultCandidate[];
};

/**
 * Builds the customer-facing result summary saved into local case memory.
 *
 * Ranking owns candidate selection only; this helper owns display counts,
 * bucket labels, and price range text.
 */
export function buildFlightResultFilterSummary(
  input: FlightResultSummaryInput,
): FlightResultFilterSummary {
  return {
    ranking: input.ranking,
    requestedTimeBucket: input.requestedTimeBucket,
    requestedTimeBucketLabel: input.requestedTimeBucket
      ? FLIGHT_TIME_BUCKETS[input.requestedTimeBucket].label
      : null,
    totalVisibleCount: input.totalVisibleCount,
    matchedCount:
      input.ranking === 'cheapest'
        ? input.scopedCandidates.filter((candidate) => candidate.priceAmount !== null)
            .length
        : input.scopedCandidates.length,
    displayedCount: input.selectedCandidates.length,
    priceRangeText: formatPriceRange(input.selectedCandidates),
  };
}

function formatPriceRange(candidates: FlightResultCandidate[]) {
  const prices = candidates
    .map((candidate) => candidate.priceAmount)
    .filter((price): price is number => price !== null)
    .sort((left, right) => left - right);

  if (prices.length === 0) {
    return null;
  }

  const lowestPrice = prices[0];
  const highestPrice = prices[prices.length - 1];

  return lowestPrice === highestPrice
    ? `${formatVndAmount(lowestPrice)} VND`
    : `${formatVndAmount(lowestPrice)} VND - ${formatVndAmount(highestPrice)} VND`;
}
