import { type Page } from 'playwright';

const PNR_PATTERN = /^[A-Z0-9]{6}$/;

/**
 * Extracts the held-booking PNR from the expected order flight card.
 *
 * Responsibilities:
 * - Scope extraction to the order card that contains the expected flight and
 *   visible `Đang giữ chỗ` state.
 * - Reject order ids, flight numbers, fare classes, and malformed values.
 * - Return one validated six-character PNR for Telegram and local case memory.
 */
export async function extractHeldBookingPnr(
  page: Page,
  expectedFlightNumber: string,
) {
  const candidateTexts = await getHeldOrderFlightCards(
    page,
    expectedFlightNumber,
  ).allInnerTexts();

  for (const candidateText of candidateTexts.sort(
    (left, right) => left.length - right.length,
  )) {
    const pnrCodes = extractPnrCodesFromHeldOrderText(
      candidateText,
      expectedFlightNumber,
    );

    if (pnrCodes.length === 1) {
      return pnrCodes[0];
    }
  }

  throw new Error(
    `Expected exactly one held-booking PNR for ${expectedFlightNumber}.`,
  );
}

/**
 * Locates held-order card candidates from durable order-page content.
 */
export function getHeldOrderFlightCards(
  page: Page,
  expectedFlightNumber: string,
) {
  const exactFlightNumber = page.getByText(
    buildExactFlightNumberPattern(expectedFlightNumber),
  );

  return exactFlightNumber.locator(
    'xpath=ancestor::div[.//*[normalize-space(.)="Đang giữ chỗ" or normalize-space(.)="Dang giu cho"]][1]',
  );
}

/**
 * Matches only the leaf node that renders one flight number.
 *
 * 1Booking card ancestors concatenate adjacent labels such as `VJ634A321`.
 * Looking up the exact leaf first keeps the card locator stable without
 * depending on whitespace between the flight number and aircraft code.
 */
export function buildExactFlightNumberPattern(expectedFlightNumber: string) {
  return new RegExp(`^\\s*${escapeRegExp(expectedFlightNumber)}\\s*$`, 'i');
}

/**
 * Reads valid PNR candidates from one held-order card text snapshot.
 *
 * This pure helper keeps browser selectors separate from PNR validation and
 * gives contract tests a stable boundary.
 */
export function extractPnrCodesFromHeldOrderText(
  orderCardText: string,
  expectedFlightNumber: string,
) {
  const excludedValues = new Set([expectedFlightNumber.trim().toUpperCase()]);

  return Array.from(
    new Set(
      Array.from(orderCardText.toUpperCase().matchAll(/\b[A-Z0-9]{6}\b/g))
        .map((match) => match[0])
        .filter(
          (candidate) =>
            isValidPnrCode(candidate) && !excludedValues.has(candidate),
        ),
    ),
  );
}

/**
 * Validates the six-character uppercase alphanumeric PNR contract.
 */
export function isValidPnrCode(value: string) {
  return PNR_PATTERN.test(value.trim());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
