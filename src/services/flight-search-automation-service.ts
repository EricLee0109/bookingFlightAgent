import { createOneBookingBrowserSession } from '../automation/1booking/browser';
import { type FlightResultFilterSummary } from '../automation/1booking/flight-result-ranking';
import { searchFlights } from '../automation/1booking/flight-search';
import { type SearchFlightsInput } from '../automation/1booking/search-flight-input';
import {
  buildCaseUiScreenshotFileNamePrefix,
  takeCaseUiScreenshot,
  takeFullPageScreenshot,
} from '../automation/1booking/screenshots';
import { isRetryableOneBookingSearchError } from '../automation/1booking/waiters';
import { runWithAutomationLock } from '../utils/automation-lock';
import { OneBookingAuthRefreshRetryController } from './onebooking-auth-refresh-retry';

export type FlightSearchAutomationResult =
  | {
      ok: true;
      flightCount: number;
      displayedFlightCount: number;
      filterSummary?: FlightResultFilterSummary;
      screenshotPath: string;
      screenshotPaths: string[];
      authRefreshed?: boolean;
    }
  | {
      ok: false;
      message: string;
      errorScreenshotPath: string | null;
      authRefreshed?: boolean;
    };

const MAX_ONE_BOOKING_SEARCH_ATTEMPTS = 2;

export type FlightSearchAutomationOptions = {
  caseId?: string;
  onAuthRefresh?: () => Promise<void>;
};

/**
 * Runs a validated 1Booking flight search with browser lifecycle management.
 *
 * This service owns automation execution for the Telegram flow:
 * - creates the shared viewport/auth Playwright session
 * - calls the 1Booking search flow
 * - captures an error screenshot when Playwright fails
 * - always closes the browser session
 */
export async function searchOneBookingFlights(
  input: SearchFlightsInput,
  options: FlightSearchAutomationOptions = {},
): Promise<FlightSearchAutomationResult> {
  try {
    // use this lockName as Vietnamese for end-user understanding
    return await runWithAutomationLock('🔍 Tìm chuyến bay', () =>
      searchOneBookingFlightsUnlocked(input, options),
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown automation lock error.',
      errorScreenshotPath: null,
    };
  }
}

async function searchOneBookingFlightsUnlocked(
  input: SearchFlightsInput,
  options: FlightSearchAutomationOptions,
): Promise<FlightSearchAutomationResult> {
  let lastError: unknown = null;
  let lastErrorScreenshotPath: string | null = null;
  const authRetry = new OneBookingAuthRefreshRetryController({
    onAuthRefresh: options.onAuthRefresh,
  });

  for (let attempt = 1; attempt <= MAX_ONE_BOOKING_SEARCH_ATTEMPTS; attempt++) {
    const { browser, page } = await createOneBookingBrowserSession();

    try {
      const result = await searchFlights(page, input, {
        screenshotFileNamePrefix: options.caseId
          ? buildCaseUiScreenshotFileNamePrefix(
              options.caseId,
              'search-results',
            )
          : undefined,
      });

      return {
        ok: true,
        flightCount: result.flightCount,
        displayedFlightCount: result.displayedFlightCount,
        filterSummary: result.filterSummary,
        screenshotPath: result.screenshotPath,
        screenshotPaths: result.screenshotPaths,
        authRefreshed: authRetry.authRefreshed || undefined,
      };
    } catch (error) {
      lastError = error;

      try {
        lastErrorScreenshotPath = options.caseId
          ? await takeCaseUiScreenshot(page, options.caseId, 'search-failed')
          : await takeFullPageScreenshot(
              page,
              `1booking-telegram-search-failed-attempt-${attempt}.png`,
            );
      } catch {
        lastErrorScreenshotPath = null;
      }

      const shouldRetry =
        (isRetryableOneBookingSearchError(error) ||
          (await authRetry.refreshIfAuthExpired(error, {
            irreversible: false,
          }))) &&
        attempt < MAX_ONE_BOOKING_SEARCH_ATTEMPTS;

      if (!shouldRetry) {
        break;
      }
    } finally {
      await browser.close();
    }
  }

  return {
    ok: false,
    message:
      lastError instanceof Error
        ? lastError.message
        : 'Unknown 1Booking automation error.',
    errorScreenshotPath: lastErrorScreenshotPath,
    authRefreshed: authRetry.authRefreshed || undefined,
  };
}
