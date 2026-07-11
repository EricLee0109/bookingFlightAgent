import { resolveAirlineFromText } from '../../agent/airline-catalog';
import {
  type BookingClass,
  type FlightSelectionCandidate,
} from '../../contracts/flight';

export type ParsedFlightCard = FlightSelectionCandidate & {
  priceAmount: number | null;
};

const MVP_SUPPORTED_AIRLINE_CODES = new Set(['VJ', 'VN', 'QH', 'VU', '9S']);

/**
 * Parses one visible 1Booking flight card into a reusable search/selection
 * candidate.
 *
 * This helper owns card-text interpretation only. Ranking, screenshot capture,
 * and click automation must stay in their own components.
 */
export function parseFlightCardText(
  cardIndex: number,
  cardText: string,
): ParsedFlightCard | null {
  const airline = resolveAirlineFromText(cardText);
  const flightNumber = extractFlightNumber(cardText);
  const fareInfo = extractFlightFareInfo(cardText);
  const times = extractTimes(cardText);

  if (
    !airline ||
    !flightNumber ||
    !isMvpSupportedAirlineCode(airline.code) ||
    times.length === 0
  ) {
    return null;
  }

  return {
    cardIndex,
    airlineCode: airline.code,
    airlineName: airline.name,
    flightNumber,
    departureTime: times[0],
    arrivalTime: times[1] ?? null,
    bookingClass: fareInfo.bookingClass,
    rawBookingClassCode: fareInfo.rawBookingClassCode,
    priceText: extractPriceText(cardText),
    priceAmount: extractLowestVndPriceAmount(cardText),
  };
}

/**
 * Checks whether an airline is enabled for the lean MVP flow.
 *
 * Airline-specific hold requirements, such as Vietnam Airlines requiring DOB,
 * are enforced later by the passenger/hold readiness layer.
 */
export function isMvpSupportedAirlineCode(airlineCode: string) {
  return MVP_SUPPORTED_AIRLINE_CODES.has(airlineCode.toUpperCase());
}

/**
 * Extracts the visible 1Booking flight number from card text.
 */
export function extractFlightNumber(cardText: string) {
  return (
    cardText.match(/\b(?:VJ|VN|QH|VU|9S)\d+[A-Z]?\b/i)?.[0]?.toUpperCase() ??
    null
  );
}

export type FlightFareInfo = {
  bookingClass: BookingClass | null;
  rawBookingClassCode: string | null;
};

/**
 * Extracts the real fare/class marker displayed on a 1Booking flight card.
 *
 * Vietjet cards often expose fare families such as `Z1_ECO`; other airlines can
 * expose native inventory codes such as `N`, `B`, `H`, or `L`. The fare family
 * is optional, while the raw code is kept for operator review and auditing.
 */
export function extractFlightFareInfo(cardText: string): FlightFareInfo {
  const parenthesizedCodes = Array.from(cardText.matchAll(/\(([A-Z0-9_]{1,12})\)/gi))
    .map((match) => match[1].toUpperCase())
    .filter(isLikelyFareCode);
  const rawBookingClassCode =
    parenthesizedCodes.find((code) => extractBookingClassFromRawFareCode(code)) ??
    parenthesizedCodes[0] ??
    null;

  return {
    bookingClass: rawBookingClassCode
      ? extractBookingClassFromRawFareCode(rawBookingClassCode)
      : null,
    rawBookingClassCode,
  };
}

function isLikelyFareCode(code: string) {
  if (/^(?:ECO|DLX|SGB|SBB)$/.test(code)) {
    return true;
  }

  if (/^[A-Z0-9]{1,4}_(?:ECO|DLX|SGB|SBB)$/.test(code)) {
    return true;
  }

  return /^[A-Z]{1,3}$/.test(code);
}

function extractBookingClassFromRawFareCode(code: string): BookingClass | null {
  const match = code.match(/(?:^|_)(ECO|DLX|SGB|SBB)$/i);

  return (match?.[1]?.toUpperCase() as BookingClass | undefined) ?? null;
}

/**
 * Extracts departure/arrival time candidates from card text.
 */
export function extractTimes(cardText: string) {
  return Array.from(cardText.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)).map(
    (match) => match[0],
  );
}

/**
 * Extracts a display price from card text for operator review.
 */
export function extractPriceText(cardText: string) {
  const lowestPrice = extractLowestVndPriceAmount(cardText);

  return lowestPrice === null ? null : `${formatVndAmount(lowestPrice)} VND`;
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

export function formatVndAmount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}
