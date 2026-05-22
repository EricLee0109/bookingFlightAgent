import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';
import {
  BOOKING_CLASS_LABELS,
  SelectMatchingFlightInputSchema,
  type BookingClass,
  type SelectMatchingFlightInput,
} from '../contracts/flight';
import { resolveAirlineFromText } from './airline-catalog';

export type FlightSelectionParseResult =
  | {
      isSelectionMessage: false;
    }
  | {
      isSelectionMessage: true;
      ok: true;
      input: SelectMatchingFlightInput;
    }
  | {
      isSelectionMessage: true;
      ok: false;
      missingFields: string[];
      message: string;
    };

/**
 * Parses an operator selection message into the safe selection contract.
 *
 * This MVP parser is deterministic: it only extracts case id, airline, flight
 * time, and booking class. The actual flight number is later read from the
 * refreshed 1Booking card to avoid AI/operator mismatch.
 */
export function parseFlightSelectionMessage(
  rawMessage: string,
): FlightSelectionParseResult {
  const caseId = rawMessage.match(BOOKING_CASE_REGEX)?.[0]?.toUpperCase();

  if (!caseId) {
    return {
      isSelectionMessage: false,
    };
  }

  const airline = resolveAirlineFromText(rawMessage);
  const departureTime = extractDepartureTime(rawMessage.replace(caseId, ''));
  const bookingClass = extractBookingClass(rawMessage);
  const missingFields: string[] = [];

  if (!airline) missingFields.push('airline');
  if (!departureTime) missingFields.push('departureTime');

  if (missingFields.length > 0) {
    return {
      isSelectionMessage: true,
      ok: false,
      missingFields,
      message:
        'Cannot parse flight selection. Please send: BK-YYYYMMDD-HHMMSS choose Vietjet 05:00 Eco.',
    };
  }

  const input = SelectMatchingFlightInputSchema.parse({
    caseId,
    airlineCode: airline.code,
    airlineName: airline.name,
    departureTime,
    bookingClass,
  });

  return {
    isSelectionMessage: true,
    ok: true,
    input,
  };
}

/**
 * Formats a booking class code for operator-facing messages.
 */
export function formatBookingClass(bookingClass: BookingClass) {
  return `${BOOKING_CLASS_LABELS[bookingClass]} (${bookingClass})`;
}

function extractDepartureTime(rawMessage: string) {
  const normalized = normalizeVietnameseText(rawMessage);
  const match = normalized.match(
    /\b([01]?\d|2[0-3])\s*(?::|h|gio)\s*([0-5]\d)?\b/,
  );

  if (!match) {
    return null;
  }

  const hour = match[1].padStart(2, '0');
  const minute = (match[2] ?? '00').padStart(2, '0');

  return `${hour}:${minute}`;
}

/**
 * Reads the requested booking class, defaulting to ECO for MVP selection.
 */
function extractBookingClass(rawMessage: string): BookingClass {
  const normalized = normalizeVietnameseText(rawMessage);

  if (/\b(sbb|sky\s*boss\s*business|skyboss\s*business)\b/.test(normalized)) {
    return 'SBB';
  }

  if (/\b(sgb|sky\s*boss|skyboss)\b/.test(normalized)) {
    return 'SGB';
  }

  if (/\b(dlx|deluxe|cao\s*cap)\b/.test(normalized)) {
    return 'DLX';
  }

  if (/\b(eco|economy|pho\s*thong)\b/.test(normalized)) {
    return 'ECO';
  }

  return 'ECO';
}

/**
 * Normalizes Vietnamese operator text before simple regex extraction.
 */
function normalizeVietnameseText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}
