import { type Locator, type Page } from 'playwright';

function parseFlightResultCount(text: string) {
  const match = text.match(/tìm thấy\s+(\d+)\s+kết quả/i);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

async function countRenderedFlightOptions(flightOptions: Locator) {
  return flightOptions.evaluateAll((elements) =>
    elements.filter(
      (element) =>
        element instanceof HTMLElement &&
        Boolean(
          element.offsetWidth ||
            element.offsetHeight ||
            element.getClientRects().length,
        ),
    ).length,
  );
}

async function waitForFlightOptionsCount(
  page: Page,
  flightOptions: Locator,
  expectedCount: number,
) {
  const timeoutMs = 30000;
  const startedAt = Date.now();
  let renderedCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    renderedCount = await countRenderedFlightOptions(flightOptions);

    if (renderedCount >= expectedCount) {
      return renderedCount;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `Flight result count mismatch after waiting. Summary says ${expectedCount}, but found ${renderedCount} rendered option(s).`,
  );
}

/**
 * Waits for common 1Booking loading indicators to disappear.
 *
 * This component owns UI loading synchronization only. It does not decide
 * whether search results are valid.
 */
export async function waitForLoadingOverlayToDisappear(page: Page) {
  const possibleLoadingOverlays = [
    '.ant-spin',
    '.ant-spin-spinning',
    '[aria-busy="true"]',
    '[role="progressbar"]',
    'text=Đang tải',
    'text=Loading',
  ];

  for (const selector of possibleLoadingOverlays) {
    const loader = page.locator(selector).first();

    try {
      if (await loader.isVisible({ timeout: 1000 })) {
        await loader.waitFor({
          state: 'hidden',
          timeout: 30000,
        });
      }
    } catch {
      // Ignore missing loader selectors.
    }
  }
}

/**
 * Waits until 1Booking flight results are fully rendered and safe to screenshot.
 *
 * This component owns result readiness:
 * - reads the summary count from the 1Booking UI
 * - waits for the rendered flight cards to catch up
 * - fails when the page still looks incomplete after the bounded wait
 */
export async function waitForFlightResultsReady(page: Page) {
  await waitForLoadingOverlayToDisappear(page);

  const resultSummary = page
    .locator('div')
    .filter({
      hasText: /tìm thấy\s+\d+\s+kết quả/i,
    })
    .last();

  await resultSummary.waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const summaryText = await resultSummary.innerText();
  const countFromSummary = parseFlightResultCount(summaryText);

  if (countFromSummary === null) {
    throw new Error(`Could not parse flight result count from: ${summaryText}`);
  }

  if (countFromSummary < 1) {
    throw new Error('Expected at least 1 flight result, but found 0.');
  }

  const flightOptions = page
    .getByRole('list', { name: /Single ticket options/i })
    .locator(':scope > div');

  await flightOptions.first().waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const visibleFlightOptionCount = await waitForFlightOptionsCount(
    page,
    flightOptions,
    countFromSummary,
  );

  if (visibleFlightOptionCount > countFromSummary) {
    throw new Error(
      `Flight result count mismatch. Summary says ${countFromSummary}, but found ${visibleFlightOptionCount} visible option(s).`,
    );
  }

  await page.waitForLoadState('networkidle', {
    timeout: 10000,
  }).catch(() => null);

  // Small render-stabilization delay before screenshot.
  await page.waitForTimeout(1500);

  return countFromSummary;
}
