import {
  type FlightResultRanking,
  type FlightSelectionCandidate,
} from '../../contracts/flight';

export type FlightTimeBucket =
  | 'early_morning'
  | 'morning'
  | 'afternoon'
  | 'night';

export type FlightResultCandidate = FlightSelectionCandidate & {
  priceAmount: number | null;
};

export type FlightResultFilterSummary = {
  ranking?: FlightResultRanking;
  requestedTimeBucket: FlightTimeBucket | null;
  requestedTimeBucketLabel: string | null;
  totalVisibleCount: number;
  matchedCount: number;
  displayedCount: number;
  priceRangeText: string | null;
};

export type RankedFlightResult = {
  candidates: FlightResultCandidate[];
  cardIndexes: number[];
  summary: FlightResultFilterSummary;
};
