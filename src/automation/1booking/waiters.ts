import { type Locator, type Page } from 'playwright';

export class RetryableOneBookingSearchError extends Error {
  readonly retryable = true;
}

/**
 * Checks whether an automation error is safe to retry with the same search input.
 */
export function isRetryableOneBookingSearchError(error: unknown) {
  return (
    error instanceof RetryableOneBookingSearchError ||
    (error instanceof Error &&
      'retryable' in error &&
      error.retryable === true)
  );
}

/**
 * Fails fast when 1Booking shows the login modal during automation.
 *
 * This usually means the saved auth state has expired. The caller/service owns
 * screenshot capture, so this helper only reports the actionable cause.
 */
export async function throwIfOneBookingLoginModalVisible(
  page: Page,
  timeoutMs = 1500,
) {
  const passwordInput = page.locator('input[type="password"]').first();
  const loginModalVisible = await passwordInput
    .waitFor({
      state: 'visible',
      timeout: timeoutMs,
    })
    .then(() => true)
    .catch(() => false);

  if (loginModalVisible) {
    throw new Error(
      '1Booking auth session expired or login is required. Run pnpm run save-auth:dev, then retry the search.',
    );
  }
}

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

async function hasVisibleProviderSearchLoading(page: Page) {
  const providerLoadingText = page
    .getByText(/Đang tìm hệ thống|Dang tim he thong/i)
    .first();

  return providerLoadingText
    .isVisible({
      timeout: 500,
    })
    .catch(() => false);
}

/**
 * Waits for provider-level background fetching to finish after cards appear.
 *
 * 1Booking can render partial flight results while one provider is still loading.
 * Customer screenshots should not include those skeleton/loading rows. If the
 * provider fetch stays stuck, the caller can retry the same search input.
 */
export async function waitForProviderSearchToSettle(page: Page) {
  const timeoutMs = 30000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!(await hasVisibleProviderSearchLoading(page))) {
      return;
    }

    await page.waitForTimeout(1000);
  }

  throw new RetryableOneBookingSearchError(
    '1Booking provider search is still loading after 30s. Retrying the same SearchFlightsInput may recover.',
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

  await waitForProviderSearchToSettle(page);

  await page.waitForLoadState('networkidle', {
    timeout: 10000,
  }).catch(() => null);

  // Small render-stabilization delay before screenshot.
  await page.waitForTimeout(1500);

  return countFromSummary;
}
