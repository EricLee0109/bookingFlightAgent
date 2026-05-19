import { createOneBookingBrowserSession } from '../automation/1booking/browser';
import { searchFlights } from '../automation/1booking/flight-search';
import { type SearchFlightsInput } from '../automation/1booking/search-flight-input';
import { takeFullPageScreenshot } from '../automation/1booking/screenshots';
import { runWithAutomationLock } from '../utils/automation-lock';

export type FlightSearchAutomationResult =
  | {
      ok: true;
      flightCount: number;
      screenshotPath: string;
    }
  | {
      ok: false;
      message: string;
      errorScreenshotPath: string | null;
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
): Promise<FlightSearchAutomationResult> {
  try {
    return await runWithAutomationLock('1booking-search-flights', () =>
      searchOneBookingFlightsUnlocked(input),
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
): Promise<FlightSearchAutomationResult> {
  const { browser, page } = await createOneBookingBrowserSession();

  try {
    const result = await searchFlights(page, input);

    return {
      ok: true,
      flightCount: result.flightCount,
      screenshotPath: result.screenshotPath,
    };
  } catch (error) {
    let errorScreenshotPath: string | null = null;

    try {
      errorScreenshotPath = await takeFullPageScreenshot(
        page,
        '1booking-telegram-search-failed.png',
      );
    } catch {
      errorScreenshotPath = null;
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown 1Booking automation error.',
      errorScreenshotPath,
    };
  } finally {
    await browser.close();
  }
}
