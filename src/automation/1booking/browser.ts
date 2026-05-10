import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_VIEWPORT,
} from './constants';

export type OneBookingBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

/**
 * Creates a Playwright browser session for 1Booking automation.
 *
 * Responsibilities:
 * - Launch Chromium.
 * - Load saved authentication state.
 * - Apply the shared 1Booking viewport.
 * - Return browser, context, and page for automation flows.
 */

export async function createOneBookingBrowserSession(): Promise<OneBookingBrowserSession> {
  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext({
    storageState: ONE_BOOKING_STORAGE_STATE_PATH,
    viewport: ONE_BOOKING_VIEWPORT,
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
  };
}