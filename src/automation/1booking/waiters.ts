import { type ElementHandle, type Locator, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { ensureScreenshotDir } from './screenshots';
import { SCREENSHOT_DIR } from './constants';

const ONE_BOOKING_IMPORTANT_NOTICE_HEADING =
  /LƯU Ý QUAN TRỌNG|LUU Y QUAN TRONG/i;

type OneBookingPromotionHandlerState = {
  locator: Locator;
  screenshotPrefix: string;
  timeoutMs: number;
  registration: Promise<void>;
};

const oneBookingPromotionHandlers = new WeakMap<
  Page,
  OneBookingPromotionHandlerState
>();

/** Builds the exact image-slider dialog locator used by promotion cleanup. */
function getOneBookingPromotionLocator(page: Page) {
  return page
    .locator('.ant-modal[role="dialog"]')
    .filter({
      has: page.locator('.ant-carousel img[src*="/files/imagesliders/"]'),
    })
    .first();
}

/** Installs one page-scoped handler so a late promotion cannot intercept actions. */
async function ensureOneBookingPromotionHandler(
  page: Page,
  timeoutMs: number,
  screenshotPrefix: string,
) {
  const existing = oneBookingPromotionHandlers.get(page);

  if (existing) {
    existing.timeoutMs = Math.max(timeoutMs, 1);
    existing.screenshotPrefix = screenshotPrefix;
    await existing.registration;
    return;
  }

  const state: OneBookingPromotionHandlerState = {
    locator: getOneBookingPromotionLocator(page),
    screenshotPrefix,
    timeoutMs: Math.max(timeoutMs, 1),
    registration: Promise.resolve(),
  };

  state.registration = page
    .addLocatorHandler(state.locator, async () => {
      await closeOneBookingPromotionPopup(
        page,
        state.timeoutMs,
        state.screenshotPrefix,
      );
    })
    .catch((error) => {
      if (oneBookingPromotionHandlers.get(page) === state) {
        oneBookingPromotionHandlers.delete(page);
      }
      throw error;
    });

  oneBookingPromotionHandlers.set(page, state);
  await state.registration;
}

/** Waits for an overlay handle to hide, treating immediate detachment as closed. */
async function waitForOneBookingOverlayToHide(overlay: ElementHandle) {
  try {
    await overlay.waitForElementState('hidden', { timeout: 3000 });
  } catch (error) {
    if (await overlay.isVisible().catch(() => false)) {
      throw error;
    }
  }
}

/** Clears only known search-blocking advertisements, including delayed promotions. */
export async function closeOneBookingSearchOverlays(page: Page, timeoutMs = 2000, screenshotPrefix = '1booking') {
  await ensureOneBookingPromotionHandler(page, timeoutMs, screenshotPrefix);
  await closeOneBookingPromotionPopup(page, timeoutMs, screenshotPrefix);
  await closeOneBookingImportantNoticeDrawer(page, timeoutMs);
  // A promotion can appear while the optional notice is being dismissed.
  await closeOneBookingPromotionPopup(page, 500, screenshotPrefix);
}

/** Recognizes the observed image-slider modal without dismissing login or booking dialogs. */
export async function closeOneBookingPromotionPopup(page: Page, timeoutMs = 2000, screenshotPrefix = '1booking') {
  const promotion = getOneBookingPromotionLocator(page);
  try {
    await promotion.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return false;
    throw error;
  }
  const evidencePrefix = `${screenshotPrefix.replace(/[^a-zA-Z0-9_-]/g, '-')}-promotion-${Date.now()}-${randomUUID()}`;
  await capturePromotionEvidence(page, `${evidencePrefix}-before`);
  const root = promotion.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-modal-root ")][1]');
  try {
    // Keep the original mask and wrapper: the modal can unmount before either
    // sibling overlay finishes its fade-out.
    const mask = await root.locator('.ant-modal-mask').elementHandle({ timeout: 3000 });
    if (!mask) throw new Error('Promotion mask not found.');
    const wrapperLocator = root.locator('.ant-modal-wrap').first();
    const wrapper =
      (await wrapperLocator.count()) > 0
        ? await wrapperLocator.elementHandle({ timeout: 3000 })
        : null;
    await promotion.getByRole('button', { name: 'Đóng', exact: true }).click({ timeout: 3000 });
    await Promise.all([
      promotion.waitFor({ state: 'hidden', timeout: 3000 }),
      wrapper ? waitForOneBookingOverlayToHide(wrapper) : Promise.resolve(),
      waitForOneBookingOverlayToHide(mask),
    ]);
    await wrapper?.dispose();
    await mask.dispose();
  } catch {
    await capturePromotionEvidence(page, `${evidencePrefix}-failed`);
    throw new Error('1Booking promotion popup remained open and blocked the search form.');
  }
  await capturePromotionEvidence(page, `${evidencePrefix}-after`);
  return true;
}

/** Saves bounded before/after evidence without allowing screenshot failures to block dismissal. */
async function capturePromotionEvidence(page: Page, name: string) {
  try {
    await ensureScreenshotDir();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, timeout: 2000 });
  } catch {
    console.warn('[1Booking] Could not capture promotion popup screenshot.');
  }
}

export class RetryableOneBookingSearchError extends Error {
  readonly retryable = true;
}

/**
 * Error raised when 1Booking shows an expired-login state.
 *
 * Services can safely refresh auth and retry only while no irreversible action
 * has been submitted.
 */
export class OneBookingAuthExpiredError extends Error {
  readonly authExpired = true;
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
 * Checks whether an automation/API error represents expired 1Booking auth.
 */
export function isOneBookingAuthExpiredError(error: unknown) {
  return (
    error instanceof OneBookingAuthExpiredError ||
    (error instanceof Error &&
      'authExpired' in error &&
      error.authExpired === true)
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
  await page.waitForTimeout(timeoutMs).catch(() => null);

  if (await hasOneBookingAuthExpiredState(page)) {
    throw new OneBookingAuthExpiredError(
      '1Booking auth session expired or login is required. Refreshing 1Booking auth state is required.',
    );
  }
}

/**
 * Closes the optional 1Booking important-notice drawer when it appears.
 *
 * 1Booking can show this right-side banner after dashboard navigation. It is
 * not part of the booking flow and can cover search/result locators, so browser
 * flows call this helper before interacting with the page.
 */
export async function closeOneBookingImportantNoticeDrawer(
  page: Page,
  timeoutMs = 2000,
) {
  const heading = page.getByText(ONE_BOOKING_IMPORTANT_NOTICE_HEADING).first();
  const didAppear = await heading
    .waitFor({
      state: 'visible',
      timeout: timeoutMs,
    })
    .then(() => true)
    .catch(() => false);

  if (!didAppear) {
    return false;
  }

  const drawer = page
    .locator('.ant-drawer:visible, [role="dialog"]:visible')
    .filter({
      hasText: ONE_BOOKING_IMPORTANT_NOTICE_HEADING,
    })
    .first();
  const drawerMask = page.locator('.ant-drawer-mask:visible').first();

  const closeTargets = [
    drawer.locator('.ant-drawer-close').first(),
    drawer
      .locator(
        '[aria-label="Close"], [aria-label="close"], [aria-label="Đóng"]',
      )
      .first(),
    drawer.getByRole('button', { name: /close|đóng|dong/i }).first(),
  ];

  for (const closeTarget of closeTargets) {
    const canClick = await closeTarget
      .isVisible()
      .catch(() => false);

    if (!canClick) {
      continue;
    }

    const didClick = await closeTarget
      .click({
        timeout: 2000,
      })
      .then(() => true)
      .catch(() => false);

    if (
      didClick &&
      (await waitForImportantNoticeDrawerToClose(heading, drawerMask))
    ) {
      return true;
    }
  }

  await page.keyboard.press('Escape').catch(() => null);

  if (await waitForImportantNoticeDrawerToClose(heading, drawerMask)) {
    return true;
  }

  throw new Error(
    '1Booking important-notice drawer remained open and blocked the search form.',
  );
}

/**
 * Confirms the notice content and its pointer-intercepting mask are gone.
 *
 * Ant Design keeps the drawer root mounted and Playwright can still consider
 * that off-screen root visible after the close animation finishes.
 */
async function waitForImportantNoticeDrawerToClose(
  heading: Locator,
  drawerMask: Locator,
) {
  return Promise.all([
    heading.waitFor({
      state: 'hidden',
      timeout: 3000,
    }),
    drawerMask.waitFor({
      state: 'hidden',
      timeout: 3000,
    }),
  ])
    .then(() => true)
    .catch(() => false);
}

/**
 * Detects expired 1Booking auth from both the login modal and API 498 toast.
 *
 * 1Booking can show a delayed "Phiên đăng nhập đã hết hạn" notification before
 * or alongside the password modal, so checking only the password input can miss
 * the actual expired-session state.
 */
async function hasOneBookingAuthExpiredState(page: Page) {
  const passwordInput = page.locator('input[type="password"]').first();
  const loginModalVisible = await passwordInput
    .isVisible({
      timeout: 500,
    })
    .catch(() => false);

  if (loginModalVisible) {
    return true;
  }

  const bodyText = await page
    .locator('body')
    .innerText({
      timeout: 500,
    })
    .catch(() => '');
  const normalizedText = normalizeVietnameseUiText(bodyText);

  return (
    normalizedText.includes('loi 498') ||
    normalizedText.includes('phien dang nhap da het han') ||
    normalizedText.includes('dang nhap')
  );
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

async function hasProviderSearchLoadingInBody(page: Page) {
  const bodyText = await page
    .locator('body')
    .innerText({
      timeout: 500,
    })
    .catch(() => '');
  const normalizedText = normalizeVietnameseUiText(bodyText);

  return normalizedText.includes('dang tim he thong');
}

/**
 * Normalizes 1Booking Vietnamese UI text before loading-state detection.
 */
function normalizeVietnameseUiText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
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
    if (!(await hasProviderSearchLoadingInBody(page))) {
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
export async function waitForFlightResultsReady(
  page: Page,
  options: { allowEmpty?: boolean } = {},
) {
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

  if (countFromSummary < 1 && !options.allowEmpty) {
    throw new Error('Expected at least 1 flight result, but found 0.');
  }

  if (countFromSummary < 1) {
    // A zero summary can be painted before the provider finishes its
    // background request.  Only the explicit full-snapshot caller may accept
    // zero, and it must wait for provider loading to settle first.
    await waitForProviderSearchToSettle(page);
    await page.waitForLoadState('networkidle', {
      timeout: 10000,
    }).catch(() => null);
    await page.waitForTimeout(1500);

    const settledSummaryText = await resultSummary.innerText();
    const settledCount = parseFlightResultCount(settledSummaryText);
    if (settledCount === null) {
      throw new Error(`Could not parse flight result count after settling: ${settledSummaryText}`);
    }
    if (settledCount > 0) {
      return waitForFlightResultsReady(page, { allowEmpty: false });
    }

    return 0;
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

  // Provider responses can append cards after the first summary/count pair.
  // Re-read the summary after settling so a full snapshot never claims to
  // contain the complete result set using an earlier partial count.
  const settledSummaryText = await resultSummary.innerText();
  const settledCount = parseFlightResultCount(settledSummaryText);
  if (settledCount === null) {
    throw new Error(`Could not parse flight result count after settling: ${settledSummaryText}`);
  }
  if (settledCount < 1) {
    if (options.allowEmpty) return 0;
    throw new Error('Expected at least 1 flight result, but found 0.');
  }
  if (settledCount !== countFromSummary) {
    const settledVisibleFlightOptionCount = await waitForFlightOptionsCount(
      page,
      flightOptions,
      settledCount,
    );
    if (settledVisibleFlightOptionCount > settledCount) {
      throw new Error(
        `Flight result count mismatch after settling. Summary says ${settledCount}, but found ${settledVisibleFlightOptionCount} visible option(s).`,
      );
    }
  }

  return settledCount;
}
