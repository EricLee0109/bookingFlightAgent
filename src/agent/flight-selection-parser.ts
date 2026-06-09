import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';
import {
  BOOKING_CLASS_LABELS,
  SelectMatchingFlightInputSchema,
  type BookingClass,
  type SelectMatchingFlightInput,
} from '../contracts/flight';
import { resolveAirlineFromText } from './airline-catalog';

/**
 * Agent component for parsing an operator's selected flight message. - MVP selection deterministic INSTEAD OF openAI
 *
 * This parser handles the selection intent after search results were already
 * sent to the customer. It produces a validated selection contract only.
 * 1Booking availability, flight number, and card selection are verified later
 * by the selection automation service.
 */

export type FlightSelectionParseResult =
  | {
      isSelectionMessage: false;
    }
  | {
      isSelectionMessage: true;
      ok: true;
      input: SelectMatchingFlightInput;
      resolvedCaseFromContext: boolean;
    }
  | {
      isSelectionMessage: true;
      ok: false;
      missingFields: string[];
      message: string;
    };

export type FlightSelectionParserOptions = {
  latestCaseId?: string | null;
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
  options: FlightSelectionParserOptions = {},
): FlightSelectionParseResult {
  const explicitCaseId = rawMessage.match(BOOKING_CASE_REGEX)?.[0]?.toUpperCase();
  const usesLatestCaseContext = mentionsLatestCaseReference(rawMessage);
  const usesImplicitLatestCaseSelection =
    !explicitCaseId &&
    !usesLatestCaseContext &&
    mentionsImplicitLatestCaseSelection(rawMessage);
  const caseId =
    explicitCaseId ??
    (usesLatestCaseContext || usesImplicitLatestCaseSelection
      ? options.latestCaseId?.toUpperCase()
      : null);

  if (!caseId) {
    if (
      (usesLatestCaseContext || usesImplicitLatestCaseSelection) &&
      mentionsFlightSelection(rawMessage)
    ) {
      return {
        isSelectionMessage: true,
        ok: false,
        missingFields: ['caseId'],
        message:
          'Cannot resolve latest case. Please search flights first or send an explicit BK case id.',
      };
    }

    return {
      isSelectionMessage: false,
    };
  }

  const airline = resolveAirlineFromText(rawMessage);
  const departureTime = extractDepartureTime(
    explicitCaseId ? rawMessage.replace(explicitCaseId, '') : rawMessage,
  );

  if (!airline && !departureTime && !mentionsFlightSelection(rawMessage)) {
    return {
      isSelectionMessage: false,
    };
  }

  const bookingClass = extractBookingClass(rawMessage);
  const missingFields: string[] = [];

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
    airlineCode: airline?.code ?? null,
    airlineName: airline?.name ?? null,
    departureTime,
    bookingClass,
  });

  return {
    isSelectionMessage: true,
    ok: true,
    input,
    resolvedCaseFromContext:
      !explicitCaseId &&
      (usesLatestCaseContext || usesImplicitLatestCaseSelection),
  };
}

/**
 * Formats a booking class code for operator-facing messages.
 */
export function formatBookingClass(bookingClass: BookingClass | null) {
  if (!bookingClass) {
    return 'Không chỉ định';
  }

  return `${BOOKING_CLASS_LABELS[bookingClass]} (${bookingClass})`;
}

/**
 * Extracts and normalizes the requested departure time to HH:mm.
 *
 * Supported MVP examples: "5h", "5h00", "05:00", "5 gio".
 */
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
 * Detects explicit flight-selection wording without claiming unrelated case
 * messages such as `BK-... lay chi Lanh`.
 */
function mentionsFlightSelection(rawMessage: string) {
  const normalized = normalizeVietnameseText(rawMessage);

  return (
    /\b(chon|dat|lay|book|giu)\s+(chuyen|chuyen\s+bay|ve|flight)\b/.test(
      normalized,
    ) || /\bflight\b/.test(normalized)
  );
}

/**
 * Detects natural references to the latest search case in the current chat.
 */
function mentionsLatestCaseReference(rawMessage: string) {
  const normalized = normalizeVietnameseText(rawMessage);

  return /\b(case|booking)\s+(nay|vua roi|gan nhat|moi nhat|truoc do)\b/.test(
    normalized,
  );
}

/**
 * Detects selection messages that should use the latest sent flight-list case.
 *
 * This keeps operator-friendly messages like `đặt chuyến Vietjet 22h15` on the
 * selection path while avoiding normal search requests such as `muốn bay SGN
 * ra HAN ngày 30/07`.
 */
function mentionsImplicitLatestCaseSelection(rawMessage: string) {
  if (!extractDepartureTime(rawMessage)) {
    return false;
  }

  const normalized = normalizeVietnameseText(rawMessage);
  const hasSelectionVerb = /\b(chon|dat|lay|book|giu)\b/.test(normalized);

  if (!hasSelectionVerb) {
    return false;
  }

  const hasFlightContext =
    /\b(chuyen|chuyen\s+bay|ve|flight)\b/.test(normalized) ||
    Boolean(resolveAirlineFromText(rawMessage));

  return hasFlightContext;
}

/**
 * Reads the requested booking class when the operator explicitly provides one.
 */
function extractBookingClass(rawMessage: string): BookingClass | null {
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

  return null;
}

/**
 * Normalizes Vietnamese operator text before simple regex extraction.
 */
function normalizeVietnameseText(value: string) {
  return value
    .normalize('NFD') //convert Vietnamese Unicode to unaccented (khong co dau) Vietnamese, and drop mark to next space -> Ex: ơ -> o; á -> a
    .replace(/[\u0300-\u036f]/g, '') //remove mark of Vietnamese Unicode after normalize NFD drop mark -> Ex: không -> kho^ng -> khong
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}
