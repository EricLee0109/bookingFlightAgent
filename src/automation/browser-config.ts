import { chromium, type LaunchOptions } from 'playwright';

export const ONE_BOOKING_VIEWPORT = {
  width: 1440,
  height: 900,
};

/**
 * Builds the shared Chromium launch options for local and hosted automation.
 * Headless mode is the safe default; set PLAYWRIGHT_HEADLESS=false locally
 * when a visible browser is needed for debugging or manual authentication.
 */
export function getPlaywrightLaunchOptions(
  headlessOverride?: boolean,
): LaunchOptions {
  const headless =
    headlessOverride ?? process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const channel = 'chromium';

  console.log('[Playwright] Launch configuration:', {
    platform: process.platform,
    headless,
    channel: "chromium",
  });

  return {
    headless,
    channel
  };
}
