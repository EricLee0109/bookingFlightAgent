import { type PreferredTime } from '../../contracts/flight';
import { type FlightTimeBucket } from './flight-result-types';

export const FLIGHT_TIME_BUCKETS: Record<
  FlightTimeBucket,
  {
    label: string;
    startMinute: number;
    endMinute: number;
  }
> = {
  early_morning: {
    label: 'Sáng sớm 00:00-05:59',
    startMinute: 0,
    endMinute: toMinuteOfDay('05:59'),
  },
  morning: {
    label: 'Sáng 06:00-11:59',
    startMinute: toMinuteOfDay('06:00'),
    endMinute: toMinuteOfDay('11:59'),
  },
  afternoon: {
    label: 'Chiều 12:00-17:59',
    startMinute: toMinuteOfDay('12:00'),
    endMinute: toMinuteOfDay('17:59'),
  },
  night: {
    label: 'Tối/Đêm 18:00-23:59',
    startMinute: toMinuteOfDay('18:00'),
    endMinute: toMinuteOfDay('23:59'),
  },
};

/**
 * Converts parser time preferences into the fixed customer-facing buckets.
 */
export function getFlightTimeBucketForPreferredTime(
  preferredTime: PreferredTime,
): FlightTimeBucket | null {
  if (
    preferredTime === 'early_morning' ||
    preferredTime === 'morning' ||
    preferredTime === 'afternoon' ||
    preferredTime === 'night'
  ) {
    return preferredTime;
  }

  return null;
}

/**
 * Checks whether one `HH:mm` departure time belongs to a fixed bucket.
 */
export function isFlightTimeInBucket(time: string, bucket: FlightTimeBucket) {
  const minuteOfDay = toMinuteOfDay(time);
  const bucketRange = FLIGHT_TIME_BUCKETS[bucket];

  return (
    minuteOfDay >= bucketRange.startMinute &&
    minuteOfDay <= bucketRange.endMinute
  );
}

function toMinuteOfDay(time: string) {
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    throw new Error(`Invalid flight time "${time}". Expected HH:mm.`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}
