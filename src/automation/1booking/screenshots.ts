import fs from 'node:fs/promises';
import { type Locator, type Page } from 'playwright';
import { DEFAULT_TIMEOUT, ONE_BOOKING_VIEWPORT, SCREENSHOT_DIR } from './constants';

const DEFAULT_FLIGHT_RESULTS_BATCH_SIZE = 10;

export type OneBookingUiScreenshotCheckpoint =
  | 'search-results'
  | 'search-failed'
  | 'selected-flight'
  | 'selection-failed'
  | 'passenger-form-filled'
  | 'hold-review'
  | 'hold-success'
  | 'hold-failed';

/**
 * Builds one case-scoped, chronological screenshot prefix for UI drift audits.
 */
export function buildCaseUiScreenshotFileNamePrefix(
  caseId: string,
  checkpoint: OneBookingUiScreenshotCheckpoint,
  capturedAt = new Date(),
) {
  const timestamp = capturedAt.toISOString().replace(/\D/g, '');

  return `${caseId}-${checkpoint}-${timestamp}`;
}

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
 * Captures one timestamped full-page UI checkpoint without overwriting history.
 */
export async function takeCaseUiScreenshot(
  page: Page,
  caseId: string,
  checkpoint: OneBookingUiScreenshotCheckpoint,
) {
  return takeFullPageScreenshot(
    page,
    `${buildCaseUiScreenshotFileNamePrefix(caseId, checkpoint)}.png`,
  );
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
 * image. This helper groups visible flight cards into small chunks by default.
 */
export async function takeFlightResultsBatchScreenshots(
  page: Page,
  fileNamePrefix: string,
  batchSize = DEFAULT_FLIGHT_RESULTS_BATCH_SIZE,
  includedCardIndexes?: number[],
) {
  await ensureScreenshotDir();
  await removeExistingFlightResultScreenshots(fileNamePrefix);

  const flightResults = page.getByRole('list', {
    name: /Single ticket options/i,
  });
  const flightOptions = flightResults.locator(':scope > div');
  const visibleOptionIndexes = await getVisibleLocatorIndexes(flightOptions);
  const screenshotOptionIndexes =
    includedCardIndexes && includedCardIndexes.length > 0
      ? includedCardIndexes.filter((index) => visibleOptionIndexes.includes(index))
      : visibleOptionIndexes;

  if (screenshotOptionIndexes.length === 0) {
    throw new Error('Could not locate visible flight options for screenshots.');
  }

  const paths: string[] = [];

  for (let startIndex = 0; startIndex < screenshotOptionIndexes.length; startIndex += batchSize) {
    const batchIndexes = screenshotOptionIndexes.slice(startIndex, startIndex + batchSize);
    const path = `${SCREENSHOT_DIR}/${fileNamePrefix}-${paths.length + 1}.png`;

    await captureFlightOptionsBatch(page, flightResults, flightOptions, batchIndexes, path);
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
async function getVisibleLocatorIndexes(locator: Locator) {
  const count = await locator.count();
  const indexes: number[] = [];

  for (let index = 0; index < count; index++) {
    if (await locator.nth(index).isVisible()) {
      indexes.push(index);
    }
  }

  return indexes;
}

/**
 * Captures one contiguous slice of visible flight cards.
 */
async function captureFlightOptionsBatch(
  page: Page,
  flightResults: Locator,
  flightOptions: Locator,
  batchIndexes: number[],
  path: string,
) {
  const originalViewport = page.viewportSize();
  const batchCount = batchIndexes.length;
  const { width: defaultWidth, height: defaultHeight } = ONE_BOOKING_VIEWPORT;

  await page.setViewportSize({
    width: originalViewport?.width ?? defaultWidth,
    height: Math.max(originalViewport?.height ?? defaultHeight, batchCount * 220 + 240),
  });

  try {
    await setFlightOptionsBatchVisibility(flightOptions, batchIndexes);
    await flightResults.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);

    await flightResults.screenshot({
      path,
    });
  } finally {
    await restoreFlightOptionsVisibility(flightOptions).catch(() => null);

    if (originalViewport) {
      await page.setViewportSize(originalViewport);
    }
  }
}

/**
 * Temporarily hides flight cards outside the batch before locator screenshot.
 */
async function setFlightOptionsBatchVisibility(
  flightOptions: Locator,
  visibleIndexes: number[],
) {
  await flightOptions.evaluateAll((elements, indexes) => {
    const visibleIndexSet = new Set(indexes as number[]);

    elements.forEach((element, index) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      element.dataset.originalDisplay = element.style.display;
      element.style.display = visibleIndexSet.has(index) ? '' : 'none';
    });
  }, visibleIndexes);
}

/**
 * Restores flight card display styles after a batch screenshot.
 */
async function restoreFlightOptionsVisibility(flightOptions: Locator) {
  await flightOptions.evaluateAll((elements) => {
    elements.forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      element.style.display = element.dataset.originalDisplay ?? '';
      delete element.dataset.originalDisplay;
    });
  });
}
