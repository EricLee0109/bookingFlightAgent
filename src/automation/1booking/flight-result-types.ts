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
    };

export type FlightResultCandidate = FlightSelectionCandidate & {
  priceAmount: number | null;
};

export type FlightResultFilterSummary = {
  ranking?: FlightResultRanking;
  requestedAirlineCodes: string[] | null;
  requestedAirlineNames: string[] | null;
  requestedTimeBucket: FlightTimeBucket | null;
  requestedTimeBucketLabel: string | null;
  requestedSpecificTime: string | null;
  requestedTimeWindowLabel: string | null;
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
