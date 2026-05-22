import { createOneBookingBrowserSession } from '../automation/1booking/browser';
import {
  selectMatchingFlight,
  type SelectMatchingFlightResult,
} from '../automation/1booking/flight-selection';
import { takeFullPageScreenshot } from '../automation/1booking/screenshots';
import { isRetryableOneBookingSearchError } from '../automation/1booking/waiters';
import { type SelectMatchingFlightInput } from '../contracts/flight';
import { readLocalFlightCase } from '../storage/local-case-store';
import { runWithAutomationLock } from '../utils/automation-lock';

export type FlightSelectionAutomationResult =
  | {
      ok: true;
      caseId: string;
      result: SelectMatchingFlightResult;
    }
  | {
      ok: false;
      caseId: string;
      message: string;
      errorScreenshotPath: string | null;
    };

const MAX_ONE_BOOKING_SELECTION_ATTEMPTS = 2;

/**
 * Runs validated 1Booking flight selection with browser lifecycle management.
 *
 * This service loads the previous search case, reruns the saved search input,
 * captures error screenshots on failure, and closes Playwright cleanly.
 */
export async function selectMatchingOneBookingFlight(
  input: SelectMatchingFlightInput,
): Promise<FlightSelectionAutomationResult> {
  try {
    return await runWithAutomationLock('1booking-select-matching-flight', () =>
      selectMatchingOneBookingFlightUnlocked(input),
    );
  } catch (error) {
    return {
      ok: false,
      caseId: input.caseId,
      message: error instanceof Error ? error.message : 'Unknown automation lock error.',
      errorScreenshotPath: null,
    };
  }
}

/**
 * Executes selection after the public service has acquired the automation lock.
 */
async function selectMatchingOneBookingFlightUnlocked(
  input: SelectMatchingFlightInput,
): Promise<FlightSelectionAutomationResult> {
  const flightCase = await readLocalFlightCase(input.caseId);

  if (!flightCase) {
    return {
      ok: false,
      caseId: input.caseId,
      message: `Cannot select flight. Case ${input.caseId} was not found.`,
      errorScreenshotPath: null,
    };
  }

  if (!flightCase.searchInput) {
    return {
      ok: false,
      caseId: input.caseId,
      message: `Cannot select flight. Case ${input.caseId} has no saved search input. Please search flights first.`,
      errorScreenshotPath: null,
    };
  }

  let lastError: unknown = null;
  let lastErrorScreenshotPath: string | null = null;

  for (let attempt = 1; attempt <= MAX_ONE_BOOKING_SELECTION_ATTEMPTS; attempt++) {
    const { browser, page } = await createOneBookingBrowserSession();

    try {
      const result = await selectMatchingFlight(page, flightCase.searchInput, input);

      return {
        ok: true,
        caseId: input.caseId,
        result,
      };
    } catch (error) {
      lastError = error;

      try {
        lastErrorScreenshotPath = await takeFullPageScreenshot(
          page,
          `1booking-selection-failed-attempt-${attempt}.png`,
        );
      } catch {
        lastErrorScreenshotPath = null;
      }

      const shouldRetry =
        isRetryableOneBookingSearchError(error) &&
        attempt < MAX_ONE_BOOKING_SELECTION_ATTEMPTS;

      if (!shouldRetry) {
        break;
      }
    } finally {
      await browser.close();
    }
  }

  return {
    ok: false,
    caseId: input.caseId,
    message:
      lastError instanceof Error
        ? lastError.message
        : 'Unknown 1Booking selection automation error.',
    errorScreenshotPath: lastErrorScreenshotPath,
  };
}
