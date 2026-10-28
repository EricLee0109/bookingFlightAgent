import {
  type FlightResultRanking,
  type FlightSelectionCandidate,
} from '../../contracts/flight';

export type FlightTimeBucket =
  | 'early_morning'
  | 'morning'
  | 'afternoon'
  | 'night';

export type FlightTimeFilter =
  | {
      kind: 'bucket';
      bucket: FlightTimeBucket;
      label: string;
    }
  | {
      kind: 'specific_window';
      specificTime: string;
      startMinute: number;
      endMinute: number;
      label: string;
    }
  | {
      kind: 'exact' | 'from' | 'before' | 'after' | 'between';
      startMinute: number;
      endMinute: number;
      exactMinute?: number;
      startInclusive?: boolean;
      endInclusive?: boolean;
      label: string;
    };

export type FlightResultCandidate = FlightSelectionCandidate & {
  priceAmount: number | null;
  /** Assigned only when the candidate is copied into a durable search snapshot. */
  candidateId?: string;
};

export type FlightResultFilterSummary = {
  ranking?: FlightResultRanking;
  requestedAirlineCodes: string[] | null;
  requestedAirlineNames: string[] | null;
  requestedTimeBucket: FlightTimeBucket | null;
  requestedTimeBucketLabel: string | null;
  requestedSpecificTime: string | null;
  requestedTimeWindowLabel: string | null;
  requestedTimeConstraintLabel?: string | null;
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
