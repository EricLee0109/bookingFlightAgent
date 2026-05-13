import fs from 'node:fs/promises';
import { type Page } from 'playwright';
import { SCREENSHOT_DIR } from './constants';

/**
 * Ensures the local screenshot output directory exists.
 *
 * This component owns filesystem preparation for screenshots only.
 */
export async function ensureScreenshotDir() {
  await fs.mkdir(SCREENSHOT_DIR, {
    recursive: true,
  });
}

/**
 * Captures the current full page.
 *
 * This component is used for debugging/failure evidence, not for
 * customer-facing flight option images.
 */
export async function takeFullPageScreenshot(page: Page, fileName: string) {
  await ensureScreenshotDir();

  const path = `${SCREENSHOT_DIR}/${fileName}`;

  await page.screenshot({
    path,
    fullPage: true,
  });

  return path;
}

/**
 * Captures only the rendered 1Booking flight result list.
 *
 * This component owns customer-facing search screenshots. It temporarily grows
 * the viewport so all returned flight cards are painted, captures the list, then
 * restores the original viewport for the rest of the automation flow.
 */
export async function takeFlightResultsScreenshot(page: Page, fileName: string) {
  await ensureScreenshotDir();

  const path = `${SCREENSHOT_DIR}/${fileName}`;
  const originalViewport = page.viewportSize();
  const flightResults = page.getByRole('list', {
    name: /Single ticket options/i,
  });

  await flightResults.waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const box = await flightResults.boundingBox();

  if (!box) {
    throw new Error('Could not locate flight results area for screenshot.');
  }

  try {
    await page.setViewportSize({
      width: originalViewport?.width ?? 1440,
      height: Math.ceil(box.y + box.height + 80),
    });

    await page.waitForTimeout(500);

    await flightResults.screenshot({
      path,
    });
  } finally {
    if (originalViewport) {
      await page.setViewportSize(originalViewport);
    }
  }

  return path;
}
