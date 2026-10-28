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
import type { HybridTimeConstraint } from '../../agent/hybrid-flight-request';

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
  timeConstraint?: HybridTimeConstraint | null;
}): FlightTimeFilter | null {
  if (input.timeConstraint) {
    return buildHybridTimeConstraintFilter(input.timeConstraint);
  }

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

/** Maps a pilot time constraint to an inclusive/exclusive result predicate. */
export function buildHybridTimeConstraintFilter(
  constraint: HybridTimeConstraint,
): FlightTimeFilter {
  const { startMinute: suppliedStartMinute, endMinute: suppliedEndMinute, exactMinute } =
    readHybridConstraintMinutes(constraint);
  const aroundStart = constraint.kind === 'around' && exactMinute !== undefined
    ? Math.max(0, exactMinute - SPECIFIC_TIME_WINDOW_MINUTES)
    : undefined;
  const aroundEnd = constraint.kind === 'around' && exactMinute !== undefined
    ? Math.min(1439, exactMinute + SPECIFIC_TIME_WINDOW_MINUTES)
    : undefined;
  const startMinute = aroundStart ?? (constraint.startTime
    ? suppliedStartMinute!
    : exactMinute ?? 0);
  const endMinute = aroundEnd ?? (constraint.endTime
    ? suppliedEndMinute!
    : exactMinute ?? 1439);

  if (constraint.kind === 'around') {
    return {
      kind: 'specific_window' as const,
      specificTime: constraint.exactTime!,
      startMinute,
      endMinute,
      label: `gần ${constraint.exactTime} (${formatMinuteOfDay(startMinute)}-${formatMinuteOfDay(endMinute)})`,
    };
  }

  return {
    kind: constraint.kind,
    startMinute,
    endMinute,
    exactMinute,
    startInclusive: constraint.startInclusive,
    endInclusive: constraint.endInclusive,
    label: constraint.kind === 'exact'
      ? `đúng ${constraint.exactTime}`
        : constraint.kind === 'from'
          ? `từ ${constraint.startTime}`
          : constraint.kind === 'before'
            ? `trước ${constraint.endTime}`
            : constraint.kind === 'after'
              ? `sau ${constraint.startTime}`
              : `trong khoảng ${constraint.startTime}-${constraint.endTime}`,
  };
}

/**
 * Validates a pilot constraint at the deterministic filter boundary.
 *
 * Model output normally passes through `validateHybridFlightRequest` first,
 * but follow-up compare calls can arrive directly from persisted JSON.  A
 * malformed or conflicting bound must fail closed instead of becoming an
 * empty filter or a broad all-day filter.
 */
function readHybridConstraintMinutes(constraint: HybridTimeConstraint) {
  if (
    !constraint ||
    !['around', 'exact', 'from', 'before', 'after', 'between'].includes(constraint.kind) ||
    typeof constraint.startInclusive !== 'boolean' ||
    typeof constraint.endInclusive !== 'boolean'
  ) {
    throw new Error('Khoảng giờ chưa hợp lệ.');
  }

  const hasStart = constraint.startTime !== null;
  const hasEnd = constraint.endTime !== null;
  const hasExact = constraint.exactTime !== null;

  const parseOptional = (value: string | null, label: string) => {
    if (value === null) return undefined;
    try {
      return toMinuteOfDay(value);
    } catch {
      throw new Error(`Giờ ${label} chưa hợp lệ.`);
    }
  };

  const startMinute = parseOptional(constraint.startTime, 'bắt đầu');
  const endMinute = parseOptional(constraint.endTime, 'kết thúc');
  const exactMinute = parseOptional(constraint.exactTime, 'cụ thể');

  if ((constraint.kind === 'around' || constraint.kind === 'exact') &&
      (!hasExact || hasStart || hasEnd)) {
    throw new Error('Giờ cụ thể chưa hợp lệ.');
  }
  if ((constraint.kind === 'from' || constraint.kind === 'after') &&
      (!hasStart || hasEnd || hasExact)) {
    throw new Error('Mốc giờ bắt đầu chưa hợp lệ.');
  }
  if (constraint.kind === 'before' && (!hasEnd || hasStart || hasExact)) {
    throw new Error('Mốc giờ kết thúc chưa hợp lệ.');
  }
  if (constraint.kind === 'between' &&
      (!hasStart || !hasEnd || hasExact || startMinute! > endMinute!)) {
    throw new Error('Khoảng giờ chưa hợp lệ.');
  }

  return { startMinute, endMinute, exactMinute };
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

  if (timeFilter.kind === 'exact') {
    return departureMinute === timeFilter.exactMinute;
  }

  if (timeFilter.kind === 'from') {
    return timeFilter.startInclusive === false
      ? departureMinute > timeFilter.startMinute
      : departureMinute >= timeFilter.startMinute;
  }

  if (timeFilter.kind === 'before') {
    return timeFilter.endInclusive
      ? departureMinute <= timeFilter.endMinute
      : departureMinute < timeFilter.endMinute;
  }

  if (timeFilter.kind === 'after') {
    return timeFilter.startInclusive
      ? departureMinute >= timeFilter.startMinute
      : departureMinute > timeFilter.startMinute;
  }

  if (timeFilter.kind === 'between') {
    const afterStart = timeFilter.startInclusive === false
      ? departureMinute > timeFilter.startMinute
      : departureMinute >= timeFilter.startMinute;
    const beforeEnd = timeFilter.endInclusive === false
      ? departureMinute < timeFilter.endMinute
      : departureMinute <= timeFilter.endMinute;
    return afterStart && beforeEnd;
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
