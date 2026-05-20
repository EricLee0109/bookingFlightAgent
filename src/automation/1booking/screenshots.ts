import fs from 'node:fs/promises';
import { type Locator, type Page } from 'playwright';
import { DEFAULT_TIMEOUT, ONE_BOOKING_VIEWPORT, SCREENSHOT_DIR } from './constants';

const DEFAULT_FLIGHT_RESULTS_BATCH_SIZE = 10;

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
 * (Legacy for capturing customer-facing result screenshot - Long flights list)
 * 
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
    timeout: DEFAULT_TIMEOUT,
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

/**
 * Captures customer-facing flight results in smaller batches. (Crop it to 10 flights in a screenshot)
 *
 * Long result lists are hard for operators/customers to trace in one very tall
 * image. This helper groups visible flight cards into chunks of 15 by default.
 */
export async function takeFlightResultsBatchScreenshots(
  page: Page,
  fileNamePrefix: string,
  batchSize = DEFAULT_FLIGHT_RESULTS_BATCH_SIZE,
) {
  await ensureScreenshotDir();
  await removeExistingFlightResultScreenshots(fileNamePrefix);

  const flightOptions = page
    .getByRole('list', {
      name: /Single ticket options/i,
    })
    .locator(':scope > div');
  const visibleOptionCount = await countVisibleLocators(flightOptions);

  if (visibleOptionCount === 0) {
    throw new Error('Could not locate visible flight options for screenshots.');
  }

  const paths: string[] = [];

  for (let startIndex = 0; startIndex < visibleOptionCount; startIndex += batchSize) {
    const endIndex = Math.min(startIndex + batchSize, visibleOptionCount);
    const path = `${SCREENSHOT_DIR}/${fileNamePrefix}-${paths.length + 1}.png`;

    await captureFlightOptionsBatch(page, flightOptions, startIndex, endIndex, path);
    paths.push(path);
  }

  return paths;
}

/**
 * Removes stale result screenshots for the same search output prefix.
 *
 * This prevents older single-image or previous batch files from being mistaken
 * for the current customer-facing output.
 */
async function removeExistingFlightResultScreenshots(fileNamePrefix: string) {
  const screenshotFiles = await fs.readdir(SCREENSHOT_DIR).catch(() => []);
  const escapedPrefix = escapeRegExp(fileNamePrefix);
  const staleScreenshotPattern = new RegExp(`^${escapedPrefix}(-\\d+)?\\.png$`);

  await Promise.all(
    screenshotFiles
      .filter((fileName) => staleScreenshotPattern.test(fileName))
      .map((fileName) =>
        fs.rm(`${SCREENSHOT_DIR}/${fileName}`, {
          force: true,
        }),
      ),
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Counts visible locators without assuming hidden template elements are absent.
 */
async function countVisibleLocators(locator: Locator) {
  const count = await locator.count();
  let visibleCount = 0;

  for (let index = 0; index < count; index++) {
    if (await locator.nth(index).isVisible()) {
      visibleCount++;
    }
  }

  return visibleCount;
}

/**
 * Captures one contiguous slice of visible flight cards.
 */
async function captureFlightOptionsBatch(
  page: Page,
  flightOptions: Locator,
  startIndex: number,
  endIndex: number,
  path: string,
) {
  const originalViewport = page.viewportSize();
  const firstOption = flightOptions.nth(startIndex);
  const lastOption = flightOptions.nth(endIndex - 1);
  const batchCount = endIndex - startIndex;
  const {width: width_default, height: height_default } = ONE_BOOKING_VIEWPORT;

  await page.setViewportSize({
    width: originalViewport?.width ?? width_default,
    height: Math.max(originalViewport?.height ?? height_default, batchCount * 220 + 240),
  });

  await firstOption.evaluate((element) => {
    const desiredTop = 24;
    const rect = element.getBoundingClientRect();

    window.scrollTo({
      top: window.scrollY + rect.top - desiredTop,
      behavior: 'instant',
    });
  });
  await page.waitForTimeout(350);

  const firstBox = await firstOption.boundingBox();
  const lastBox = await lastOption.boundingBox();

  if (!firstBox || !lastBox) {
    throw new Error('Could not locate flight option batch area for screenshot.');
  }

  const clipX = Math.max(0, Math.floor(firstBox.x));
  const clipY = Math.max(0, Math.floor(firstBox.y));
  const clipWidth = Math.ceil(
    Math.max(firstBox.x + firstBox.width, lastBox.x + lastBox.width) - clipX,
  );
  const clipHeight = Math.ceil(lastBox.y + lastBox.height - clipY);
  const requiredViewportHeight = Math.ceil(clipY + clipHeight + 80);
  const currentViewport = page.viewportSize();

  if ((currentViewport?.height ?? 0) < requiredViewportHeight) {
    await page.setViewportSize({
      width: currentViewport?.width ?? originalViewport?.width ?? 1440,
      height: requiredViewportHeight,
    });
    await page.waitForTimeout(250);
  }

  try {
    await page.screenshot({
      path,
      clip: {
        x: clipX,
        y: clipY,
        width: clipWidth,
        height: clipHeight,
      },
    });
  } finally {
    if (originalViewport) {
      await page.setViewportSize(originalViewport);
    }
  }
}
