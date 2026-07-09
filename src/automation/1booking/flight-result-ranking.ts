import { type Locator, type Page } from 'playwright';
import { resolveAirlineFromText } from '../../agent/airline-catalog';
import {
  type BookingClass,
  type FlightResultRanking,
  type FlightSelectionCandidate,
  type PreferredTime,
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
  ranking: FlightResultRanking;
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

const CHEAPEST_RESULT_LIMIT = 5;

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
 * Reads visible 1Booking flight result cards into structured candidates.
 *
 * This component is shared by search-result ranking and selection matching so
 * both flows interpret live 1Booking cards in the same way.
 */
export async function extractFlightResultCandidates(page: Page) {
  const flightCards = getFlightCards(page);
  const count = await flightCards.count();
  const candidates: FlightResultCandidate[] = [];

  for (let cardIndex = 0; cardIndex < count; cardIndex++) {
    const card = flightCards.nth(cardIndex);

    if (!(await card.isVisible())) {
      continue;
    }

    const candidate = parseFlightCardText(cardIndex, await card.innerText());

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

/**
 * Returns the visible 1Booking flight-card collection.
 */
export function getFlightCards(page: Page) {
  return page
    .getByRole('list', {
      name: /Single ticket options/i,
    })
    .locator(':scope > div');
}

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
  resultRanking?: FlightResultRanking;
  limit?: number;
}): RankedFlightResult | null {
  const requestedTimeBucket = getFlightTimeBucketForPreferredTime(
    input.preferredTime ?? null,
  );

  if (!requestedTimeBucket && input.resultRanking !== 'cheapest') {
    return null;
  }

  const scopedCandidates = requestedTimeBucket
    ? input.candidates.filter((candidate) =>
        isFlightTimeInBucket(candidate.departureTime, requestedTimeBucket),
      )
    : input.candidates;
  const selectedCandidates =
    input.resultRanking === 'cheapest'
      ? selectCheapestCandidates(scopedCandidates, input.limit)
      : scopedCandidates;

  return {
    candidates: selectedCandidates,
    cardIndexes: selectedCandidates.map((candidate) => candidate.cardIndex),
    summary: {
      ranking: input.resultRanking,
      requestedTimeBucket,
      requestedTimeBucketLabel: requestedTimeBucket
        ? FLIGHT_TIME_BUCKETS[requestedTimeBucket].label
        : null,
      totalVisibleCount: input.candidates.length,
      matchedCount:
        input.resultRanking === 'cheapest'
          ? scopedCandidates.filter((candidate) => candidate.priceAmount !== null)
              .length
          : scopedCandidates.length,
      displayedCount: selectedCandidates.length,
      priceRangeText: formatPriceRange(selectedCandidates),
    },
  };
}

/**
 * Backwards-compatible alias for callers/tests that still use the old name.
 */
export function rankFlightResultsForSearch(input: {
  candidates: FlightResultCandidate[];
  preferredTime?: PreferredTime;
  resultRanking?: FlightResultRanking;
  limit?: number;
}) {
  return selectFlightResultsForSearch(input);
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

/**
 * Parses one flight card's visible text into a search/selection candidate.
 */
export function parseFlightCardText(
  cardIndex: number,
  cardText: string,
): FlightResultCandidate | null {
  const airline = resolveAirlineFromText(cardText);
  const flightNumber = extractFlightNumber(cardText);
  const bookingClass = extractBookingClassFromCard(cardText);
  const times = extractTimes(cardText);

  if (!airline || !flightNumber || !bookingClass || times.length === 0) {
    return null;
  }

  return {
    cardIndex,
    airlineCode: airline.code,
    airlineName: airline.name,
    flightNumber,
    departureTime: times[0],
    arrivalTime: times[1] ?? null,
    bookingClass,
    priceText: extractPriceText(cardText),
    priceAmount: extractLowestVndPriceAmount(cardText),
  };
}

/**
 * Extracts the visible 1Booking flight number from card text.
 */
function extractFlightNumber(cardText: string) {
  return (
    cardText.match(/\b(?:VJ|VN|QH|VU|9S)\d+[A-Z]?\b/i)?.[0]?.toUpperCase() ??
    null
  );
}

/**
 * Extracts the visible booking class code from card text.
 */
function extractBookingClassFromCard(cardText: string): BookingClass | null {
  const classMatch = cardText.match(/\b(?:[A-Z0-9]+_)?(ECO|DLX|SGB|SBB)\b/i);

  return (classMatch?.[1]?.toUpperCase() as BookingClass | undefined) ?? null;
}

/**
 * Extracts departure/arrival time candidates from card text.
 */
function extractTimes(cardText: string) {
  return Array.from(cardText.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)).map(
    (match) => match[0],
  );
}

/**
 * Extracts a display price from card text for operator review.
 */
function extractPriceText(cardText: string) {
  const lowestPrice = extractLowestVndPriceAmount(cardText);

  return lowestPrice === null ? null : `VND ${formatVndAmount(lowestPrice)}`;
}

/**
 * Extracts the lowest VND amount from one card.
 *
 * 1Booking can show an old crossed price and a discounted price together. The
 * ranking path uses the lowest visible amount so discounted fares rank
 * correctly.
 */
export function extractLowestVndPriceAmount(cardText: string) {
  const prices = Array.from(cardText.matchAll(/VND\s*([\d,.]+)/gi))
    .map((match) => Number(match[1].replace(/[^\d]/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);

  return prices.length > 0 ? Math.min(...prices) : null;
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
    ? `VND ${formatVndAmount(lowestPrice)}`
    : `VND ${formatVndAmount(lowestPrice)} - ${formatVndAmount(highestPrice)}`;
}

function formatVndAmount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function toMinuteOfDay(time: string) {
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    throw new Error(`Invalid flight time "${time}". Expected HH:mm.`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}
