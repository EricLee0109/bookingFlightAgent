import { type Page } from 'playwright';

/**
 * Clicks the 1Booking flight search button.
 *
 * This component owns the search button selector so raw Playwright/codegen
 * details do not live inside the business flow orchestration.
 */
export async function submitFlightSearch(page: Page) {
  const searchButton = page.locator('button.ant-btn.w-20.xl\\:flex');

  await searchButton.waitFor({
    state: 'visible',
    timeout: 10000,
  });

  await searchButton.click();
}
