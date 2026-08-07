import fs from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import {
  attachPlaywrightPageDiagnostics,
  launchConfiguredChromium,
  logPlaywrightDiagnostic,
  toPlaywrightDiagnosticError,
} from '../browser-config';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_VIEWPORT,
} from './constants';

export type OneBookingBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  launchId: string;
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

export async function createOneBookingBrowserSession(
  options: {
    purpose?: string;
  } = {},
): Promise<OneBookingBrowserSession> {
  const purpose = options.purpose ?? '1booking-browser-session';
  const storageStatePath = path.resolve(ONE_BOOKING_STORAGE_STATE_PATH);

  try {
    await fs.access(storageStatePath);
  } catch {
    throw new Error(
      `Missing 1Booking auth state at ${storageStatePath}. ` +
        'Run "pnpm run save-auth:dev" once before starting the Telegram agent.',
    );
  }

  const { browser, launchId } = await launchConfiguredChromium({
    purpose,
  });

  try {
    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: ONE_BOOKING_VIEWPORT,
    });

    const page = await context.newPage();
    attachPlaywrightPageDiagnostics(page, {
      launchId,
      purpose,
    });

    logPlaywrightDiagnostic('log', '1Booking session ready', {
      launchId,
      purpose,
      storageStatePath,
      viewport: ONE_BOOKING_VIEWPORT,
    });

    return {
      browser,
      context,
      page,
      launchId,
    };
  } catch (error) {
    logPlaywrightDiagnostic('error', '1Booking session setup failed', {
      launchId,
      purpose,
      storageStatePath,
      error: toPlaywrightDiagnosticError(error, true),
      action: 'Refresh auth with: pnpm run save-auth:dev',
    });
    await browser.close().catch(() => null);
    throw error;
  }
}
