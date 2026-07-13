import { type PreferredTime } from '../../contracts/flight';
import {
  type FlightResultCandidate,
  type FlightTimeFilter,
} from './flight-result-types';
import {
  FLIGHT_TIME_BUCKETS,
  formatMinuteOfDay,
  getFlightTimeBucketForPreferredTime,
  toMinuteOfDay,
} from './flight-time-buckets';

const SPECIFIC_TIME_WINDOW_MINUTES = 120;

/**
 * Resolves parser time fields into the actual result-filter shape.
 *
 * Specific time wins over broad buckets because `buoi chieu khoang 17h` should
 * mean flights near 17:00, not the entire afternoon bucket.
 */
export function resolveFlightTimeFilter(input: {
  preferredTime?: PreferredTime;
  specificTime?: string | null;
}): FlightTimeFilter | null {
  if (input.preferredTime === 'specific_time' && input.specificTime) {
    return buildSpecificTimeWindow(input.specificTime);
  }

  const bucket = getFlightTimeBucketForPreferredTime(input.preferredTime ?? null);

  if (!bucket) {
    return null;
  }

  return {
    kind: 'bucket',
    bucket,
    label: FLIGHT_TIME_BUCKETS[bucket].label,
  };
}

/**
 * Checks whether a flight candidate belongs to the resolved time filter.
 */
export function isFlightCandidateInTimeFilter(
  candidate: FlightResultCandidate,
  timeFilter: FlightTimeFilter,
) {
  const departureMinute = toMinuteOfDay(candidate.departureTime);

  if (timeFilter.kind === 'bucket') {
    const bucketRange = FLIGHT_TIME_BUCKETS[timeFilter.bucket];

    return (
      departureMinute >= bucketRange.startMinute &&
      departureMinute <= bucketRange.endMinute
    );
  }

  return (
    departureMinute >= timeFilter.startMinute &&
    departureMinute <= timeFilter.endMinute
  );
}

/**
 * Builds a clamped `specificTime ± 2h` filter for customer-facing screenshots.
 */
export function buildSpecificTimeWindow(specificTime: string): FlightTimeFilter {
  const targetMinute = toMinuteOfDay(specificTime);
  const startMinute = Math.max(0, targetMinute - SPECIFIC_TIME_WINDOW_MINUTES);
  const endMinute = Math.min(1439, targetMinute + SPECIFIC_TIME_WINDOW_MINUTES);

  return {
    kind: 'specific_window',
    specificTime,
    startMinute,
    endMinute,
    label: `gần ${specificTime} (${formatMinuteOfDay(startMinute)}-${formatMinuteOfDay(
      endMinute,
    )})`,
  };
}
