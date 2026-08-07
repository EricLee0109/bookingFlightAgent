import { type Locator, type Page } from 'playwright';
import { type PassengerInfo } from '../../passengers/passenger-types';
import {
  extractPnrCodesFromHeldOrderText,
  getHeldOrderFlightCards,
  isValidPnrCode,
} from './pnr';
import { throwIfOneBookingLoginModalVisible } from './waiters';

/**
 * Uses 1Booking native quick input to hydrate the passenger form.
 *
 * Responsibilities:
 * - Build the adult `Mr|Ms FAMILY/ GIVEN [DOB]` input.
 * - Open `Nhập nhanh`, submit the native parser, and wait for its success toast.
 * - Assert that the visible form reflects the validated PassengerInfo.
 *
 * This helper intentionally does not click the final hold CTA.
 */
export async function fillAndAssertPassengerInformation(
  page: Page,
  passengerInfo: PassengerInfo,
) {
  const quickInput = buildPassengerQuickInput(passengerInfo);

  await throwIfOneBookingLoginModalVisible(page, 500);
  await enableSplitPassengerName(page);

  const quickInputButton = page
    .getByRole('button', {
      name: /^Nhập nhanh$|^Nhap nhanh$/i,
    })
    .first();

  await quickInputButton.waitFor({
    state: 'visible',
    timeout: 15000,
  });
  await quickInputButton.click();

  const quickInputTextarea = page.locator('textarea:visible').last();

  await quickInputTextarea.waitFor({
    state: 'visible',
    timeout: 10000,
  });
  await quickInputTextarea.fill(quickInput);

  const executeButton = page
    .getByRole('button', {
      name: /^Thực hiện$|^Thuc hien$/i,
    })
    .last();

  await executeButton.waitFor({
    state: 'visible',
    timeout: 10000,
  });
  await executeButton.click();
  await page
    .getByText(
      /Nhập nhanh hành khách thành công|Nhap nhanh hanh khach thanh cong/i,
    )
    .first()
    .waitFor({
      state: 'visible',
      timeout: 15000,
    });

  await assertPassengerInformation(page, passengerInfo);
}

/**
 * Builds the 1Booking adult quick-input line from validated local data.
 *
 * MVP supports only `Mr` for male and `Ms` for female adult passengers.
 */
export function buildPassengerQuickInput(passengerInfo: PassengerInfo) {
  validatePassengerInfo(passengerInfo);

  const title = passengerInfo.gender === 'M' ? 'Mr' : 'Ms';
  const name = `${passengerInfo.lastName.trim().toUpperCase()}/ ${passengerInfo.firstName
    .trim()
    .toUpperCase()}`;

  return passengerInfo.dob
    ? `${title} ${name} ${formatIsoDateForPassengerForm(passengerInfo.dob)}`
    : `${title} ${name}`;
}

export type PassengerHoldReviewExpectation = {
  passengerInfo: PassengerInfo;
  flightNumber: string;
};

export type ConfirmPassengerHoldOptions = {
  onReviewReady?: () => Promise<void>;
  onSubmitted?: () => Promise<void>;
  onLoadingObserved?: (observedAt: string) => Promise<void>;
  onSuccessModalObserved?: (observedAt: string) => Promise<void>;
};

export type HeldOrderPageProof = {
  orderId: string;
  orderDetailUrl: string;
  pnrCode?: string;
};

export type HeldOrderTerminalState = {
  orderId: string;
  hasExpectedHeldFlight: boolean;
  pnrCode?: string | null;
};

export type PostSubmitHoldCheckpoint = 'terminal_order_page';

/**
 * Error raised before submission when a 1Booking fare cannot be held.
 *
 * This is a safe failure: no irreversible hold action has been clicked and the
 * forbidden `Xuất vé ngay` CTA must remain untouched.
 */
export class HoldBookingNotSupportedError extends Error {
  constructor() {
    super(
      'Selected 1Booking fare does not support hold booking. Automation stopped before the forbidden "Xuất vé ngay" CTA.',
    );
    this.name = 'HoldBookingNotSupportedError';
  }
}

/**
 * Marks an automation failure that occurred after the irreversible hold click.
 *
 * Callers must not retry the full hold flow after this error because 1Booking
 * may already have created the booking.
 */
export class PostSubmitHoldError extends Error {
  readonly checkpoint: PostSubmitHoldCheckpoint;
  readonly originalCauseMessage: string;
  readonly currentUrl: string;

  constructor(
    checkpoint: PostSubmitHoldCheckpoint,
    cause: unknown,
    currentUrl: string,
  ) {
    const originalCauseMessage =
      cause instanceof Error ? cause.message : 'Unknown post-submit error.';

    super(
      `1Booking hold was submitted, but automation could not prove checkpoint "${checkpoint}". Manual review is required before retrying. Cause: ${originalCauseMessage} URL: ${currentUrl}`,
      {
        cause,
      },
    );
    this.name = 'PostSubmitHoldError';
    this.checkpoint = checkpoint;
    this.originalCauseMessage = originalCauseMessage;
    this.currentUrl = currentUrl;
  }
}

/**
 * Opens the final hold-review drawer after passenger form assertions pass.
 *
 * This helper intentionally stops before the drawer `Giữ chỗ` CTA so E2E tests
 * can verify the review step without creating a real booking.
 */
export async function openPassengerHoldReview(
  page: Page,
  expectation: PassengerHoldReviewExpectation,
) {
  const reviewDrawer = await openPassengerHoldReviewSummary(page, expectation);
  await getSafeFinalHoldButton(reviewDrawer);

  return reviewDrawer;
}

/**
 * Opens and verifies the final review drawer without requiring hold support.
 *
 * Safe E2E tests use this because live 1Booking fares can expose only
 * `Xuất vé ngay`. Production hold confirmation still calls
 * `openPassengerHoldReview()` and requires the exact `Giữ chỗ` CTA.
 */
export async function openPassengerHoldReviewSummary(
  page: Page,
  expectation: PassengerHoldReviewExpectation,
) {
  await throwIfOneBookingLoginModalVisible(page, 500);
  await clickPassengerFormConfirmation(page);
  await throwIfOneBookingLoginModalVisible(page, 1500);

  const reviewDrawer = await waitForPassengerHoldReviewDrawer(page);

  await assertPassengerHoldReviewSummary(reviewDrawer, expectation);

  return reviewDrawer;
}

/**
 * Confirms one held booking through the final 1Booking review drawer.
 *
 * Safety boundary:
 * - `Xác nhận` only opens the review drawer.
 * - Only the exact drawer-scoped `Giữ chỗ` CTA can create the held booking.
 * - `Xuất vé ngay` is forbidden and must never be clicked by automation.
 * - Transient progress modals are observed for audit only.
 * - The function returns only after the durable held-order page appears.
 */
export async function confirmPassengerHold(
  page: Page,
  expectation: PassengerHoldReviewExpectation,
  options: ConfirmPassengerHoldOptions = {},
) {
  const reviewDrawer = await openPassengerHoldReview(page, expectation);
  await options.onReviewReady?.();
  observeTransientHoldMarker(
    page,
    /Vui lòng đợi trong giây lát!|Vui long doi trong giay lat!/i,
    options.onLoadingObserved,
  );
  observeTransientHoldMarker(
    page,
    /Tiến trình thành công!|Tien trinh thanh cong!/i,
    options.onSuccessModalObserved,
  );

  await clickFinalHoldBooking(page, reviewDrawer);

  try {
    await options.onSubmitted?.();
    return await waitForHeldOrderPage(page, expectation.flightNumber);
  } catch (error) {
    throw new PostSubmitHoldError('terminal_order_page', error, page.url());
  }
}

/**
 * Rejects any final drawer CTA except the exact `Giữ chỗ` action.
 *
 * This pure guard exists so ticket issuance can be regression-tested without a
 * live browser. `Xuất vé ngay` is permanently forbidden for automation.
 */
export function assertSafeFinalHoldCtaText(ctaText: string) {
  const normalizedCtaText = normalizeVietnameseText(ctaText);

  if (normalizedCtaText === 'xuat ve ngay') {
    throw new Error(
      'Forbidden 1Booking action: automation must never click "Xuất vé ngay".',
    );
  }

  if (normalizedCtaText !== 'giu cho') {
    throw new Error(
      `Unsafe final 1Booking CTA "${ctaText}". Expected exact "Giữ chỗ".`,
    );
  }
}

/**
 * Clicks the passenger-form `Xác nhận` CTA that opens the hold-review drawer.
 */
async function clickPassengerFormConfirmation(page: Page) {
  const confirmButton = page.getByRole('button', {
    name: /^Xác nhận$|^Xac nhan$/i,
  });

  await confirmButton.waitFor({
    state: 'visible',
    timeout: 15000,
  });

  if ((await confirmButton.count()) !== 1) {
    throw new Error(
      'Cannot open hold review because 1Booking did not expose exactly one "Xác nhận" CTA.',
    );
  }

  if (!(await confirmButton.isEnabled())) {
    throw new Error(
      'Cannot hold booking because the 1Booking confirmation CTA is disabled after passenger fill.',
    );
  }

  await confirmButton.click();
}

/**
 * Waits for the Ant Design drawer that summarizes the pending held booking.
 */
async function waitForPassengerHoldReviewDrawer(page: Page) {
  const reviewHeading = page.getByText(
    /^Tóm tắt đặt chỗ$|^Tom tat dat cho$/i,
  );

  await reviewHeading.waitFor({
    state: 'visible',
    timeout: 15000,
  });

  const reviewDrawer = page
    .locator('.ant-drawer-content:visible')
    .filter({
      has: reviewHeading,
    });

  await reviewDrawer.waitFor({
    state: 'visible',
    timeout: 10000,
  });

  if ((await reviewDrawer.count()) !== 1) {
    throw new Error(
      'Cannot hold booking because 1Booking did not expose exactly one hold-review drawer.',
    );
  }

  return reviewDrawer;
}

/**
 * Checks that the final drawer belongs to the expected passenger and flight.
 */
async function assertPassengerHoldReviewSummary(
  reviewDrawer: Locator,
  expectation: PassengerHoldReviewExpectation,
) {
  const normalizedSummary = normalizeVietnameseText(
    await reviewDrawer.innerText(),
  );
  const expectedValues = [
    expectation.passengerInfo.lastName,
    expectation.passengerInfo.firstName,
    expectation.flightNumber,
  ];

  for (const expectedValue of expectedValues) {
    if (!normalizedSummary.includes(normalizeVietnameseText(expectedValue))) {
      throw new Error(
        `Hold-review summary assertion failed. Expected "${expectedValue}".`,
      );
    }
  }
}

/**
 * Returns the only permitted final drawer CTA after validating its label.
 */
async function getSafeFinalHoldButton(reviewDrawer: Locator) {
  const holdButton = reviewDrawer.getByRole('button', {
    name: /^Giữ chỗ$|^Giu cho$/i,
  });

  const hasVisibleHoldButton = await holdButton
    .first()
    .isVisible({
      timeout: 10000,
    })
    .catch(() => false);

  if (!hasVisibleHoldButton) {
    await throwIfHoldBookingUnsupported(reviewDrawer);

    throw new Error(
      'Cannot hold booking because the review drawer did not expose "Giữ chỗ".',
    );
  }

  if ((await holdButton.count()) !== 1) {
    throw new Error(
      'Cannot hold booking because the review drawer did not expose exactly one "Giữ chỗ" CTA.',
    );
  }

  assertSafeFinalHoldCtaText(await holdButton.innerText());

  return holdButton;
}

/**
 * Fails safely when the review drawer offers ticket issuance but not hold.
 */
async function throwIfHoldBookingUnsupported(reviewDrawer: Locator) {
  const drawerText = normalizeVietnameseText(await reviewDrawer.innerText());
  const hasUnsupportedHoldWarning = drawerText.includes(
    'chuyen bay khong ho tro giu cho',
  );
  const hasForbiddenTicketCta = await reviewDrawer
    .getByRole('button', {
      name: /^Xuất vé ngay$|^Xuat ve ngay$/i,
    })
    .first()
    .isVisible({
      timeout: 500,
    })
    .catch(() => false);

  if (hasUnsupportedHoldWarning || hasForbiddenTicketCta) {
    throw new HoldBookingNotSupportedError();
  }
}

/**
 * Clicks the exact drawer-scoped `Giữ chỗ` CTA and no other booking action.
 */
async function clickFinalHoldBooking(page: Page, reviewDrawer: Locator) {
  const holdButton = await getSafeFinalHoldButton(reviewDrawer);

  await holdButton.click();
}

/**
 * Observes one transient hold-progress marker without gating durable success.
 *
 * The modal may disappear quickly, so missing it must never turn a proven held
 * order into a false failure.
 */
function observeTransientHoldMarker(
  page: Page,
  marker: RegExp,
  onObserved?: (observedAt: string) => Promise<void>,
) {
  void page
    .getByText(marker)
    .first()
    .waitFor({
      state: 'visible',
      timeout: 120000,
    })
    .then(() => onObserved?.(new Date().toISOString()))
    .catch(() => null);
}

/**
 * Waits for the held-order detail page and its expected live flight card.
 */
async function waitForHeldOrderPage(page: Page, flightNumber: string) {
  const heldFlightCard = getHeldOrderFlightCards(page, flightNumber).first();

  const orderPageProof = await waitForOrderDetailHeldState(
    page,
    heldFlightCard,
  ).catch(async (error) => {
    const dashboardProof = await waitForDashboardHeldBookingProof(
      page,
      flightNumber,
    ).catch(() => null);

    if (dashboardProof) {
      return dashboardProof;
    }

    throw error;
  });

  return orderPageProof;
}

/**
 * Confirms the preferred order-detail terminal state after hold submission.
 */
async function waitForOrderDetailHeldState(
  page: Page,
  heldFlightCard: Locator,
) {
  await page.waitForURL(
    (url) => extractHeldOrderIdFromOrderDetailUrl(url.toString()) !== null,
    {
      timeout: 120000,
    },
  );
  await heldFlightCard.waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const orderDetailUrl = page.url();
  const orderIdText = extractHeldOrderIdFromOrderDetailUrl(orderDetailUrl);

  if (!orderIdText) {
    throw new Error('1Booking order page URL did not expose a valid order id.');
  }

  if (
    !isDurableHeldOrderTerminalState({
      orderId: orderIdText,
      hasExpectedHeldFlight: await heldFlightCard.isVisible(),
    })
  ) {
    throw new Error('1Booking order page did not expose a durable held-order state.');
  }

  return {
    orderId: orderIdText,
    orderDetailUrl,
  };
}

/**
 * Extracts the held-order id from the durable order-detail URL.
 *
 * The current 1Booking UI embeds `#HS...` in a larger heading instead of
 * rendering it as a standalone text node, while the URL remains stable.
 */
export function extractHeldOrderIdFromOrderDetailUrl(orderDetailUrl: string) {
  try {
    const pathname = new URL(orderDetailUrl).pathname;
    const match = pathname.match(/^\/order\/(HS\d+)\/?$/i);

    return match ? `#${match[1].toUpperCase()}` : null;
  } catch {
    return null;
  }
}

/**
 * Confirms the new dashboard `Booking đến hạn` fallback state.
 *
 * Some 1Booking sessions now return to the dashboard after a successful hold.
 * The visible card contains a PNR but not the flight number, so this fallback
 * accepts only one valid PNR on a page that visibly contains `Booking đến hạn`.
 */
async function waitForDashboardHeldBookingProof(
  page: Page,
  flightNumber: string,
) {
  const bookingDueHeading = page.getByText(
    /Booking đến hạn|Booking den han/i,
  );

  await bookingDueHeading.first().waitFor({
    state: 'visible',
    timeout: 120000,
  });

  const pageText = await page.locator('body').innerText();
  const pnrCodes = extractPnrCodesFromHeldOrderText(pageText, flightNumber);

  if (pnrCodes.length !== 1) {
    throw new Error(
      `Dashboard held-booking proof expected one PNR, found ${pnrCodes.length}.`,
    );
  }

  if (
    !isDurableHeldOrderTerminalState({
      orderId: '',
      hasExpectedHeldFlight: true,
      pnrCode: pnrCodes[0],
    })
  ) {
    throw new Error('Dashboard booking card did not expose a durable PNR state.');
  }

  return {
    orderId: '',
    orderDetailUrl: page.url(),
    pnrCode: pnrCodes[0],
  };
}

/**
 * Treats the durable held-order page as the source of truth after submission.
 *
 * Transient loading and success modals are intentionally absent from this
 * contract because missing them must not turn a real booking into a failure.
 */
export function isDurableHeldOrderTerminalState(
  state: HeldOrderTerminalState,
) {
  return (
    (/^#HS\d+$/i.test(state.orderId.trim()) ||
      Boolean(state.pnrCode && isValidPnrCode(state.pnrCode))) &&
    state.hasExpectedHeldFlight
  );
}

/**
 * Verifies the browser-visible passenger form before the final hold action.
 */
export async function assertPassengerInformation(
  page: Page,
  passengerInfo: PassengerInfo,
) {
  await assertVisibleInputValue(page, passengerInfo.lastName, 'lastName');
  await assertVisibleInputValue(page, passengerInfo.firstName, 'firstName');

  const selectedGenders = await page
    .locator('.ant-select-selection-item')
    .allInnerTexts();
  const expectedGenderPattern =
    passengerInfo.gender === 'M' ? /Nam|Mr/i : /Nữ|Nu|Ms/i;

  if (!selectedGenders.some((gender) => expectedGenderPattern.test(gender))) {
    throw new Error(
      `Passenger gender assertion failed. Expected ${passengerInfo.gender}.`,
    );
  }

  if (passengerInfo.dob) {
    await assertInputValue(
      getDobInput(page),
      formatIsoDateForPassengerForm(passengerInfo.dob),
      'dob',
    );
  }
}

/**
 * Enables split-name mode before native quick input hydrates passenger fields.
 */
async function enableSplitPassengerName(page: Page) {
  const splitNameToggle = page.getByRole('switch').first();

  await splitNameToggle.waitFor({
    state: 'visible',
    timeout: 15000,
  });

  const isChecked =
    (await splitNameToggle.getAttribute('aria-checked')) === 'true' ||
    (await splitNameToggle.evaluate((element) =>
      element.classList.contains('ant-switch-checked'),
    ));

  if (!isChecked) {
    await splitNameToggle.click();
  }

  await page.waitForTimeout(500);
}

function getDobInput(page: Page) {
  return page.getByPlaceholder(/^Ngày sinh$|^Ngay sinh$/i).first();
}

async function assertInputValue(
  input: Locator,
  expectedValue: string,
  fieldName: string,
) {
  const actualValue = await input.inputValue();

  if (actualValue.trim().toUpperCase() !== expectedValue.trim().toUpperCase()) {
    throw new Error(
      `Passenger ${fieldName} assertion failed. Expected "${expectedValue}", found "${actualValue}".`,
    );
  }
}

async function assertVisibleInputValue(
  page: Page,
  expectedValue: string,
  fieldName: string,
) {
  const normalizedExpectedValue = expectedValue.trim().toUpperCase();
  const matched = await page.locator('input:visible').evaluateAll(
    (inputs, expected) =>
      inputs.some(
        (input) =>
          input instanceof HTMLInputElement &&
          input.value.trim().toUpperCase() === expected,
      ),
    normalizedExpectedValue,
  );

  if (!matched) {
    throw new Error(
      `Passenger ${fieldName} assertion failed. Expected hydrated value "${expectedValue}".`,
    );
  }
}

function validatePassengerInfo(passengerInfo: PassengerInfo) {
  if (!passengerInfo.gender) {
    throw new Error('Passenger gender is required before 1Booking form fill.');
  }

  if (!passengerInfo.lastName.trim() || !passengerInfo.firstName.trim()) {
    throw new Error(
      'Passenger full name is required before 1Booking form fill.',
    );
  }
}

function formatIsoDateForPassengerForm(isoDate: string) {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error(`Invalid passenger DOB: ${isoDate}. Expected YYYY-MM-DD.`);
  }

  return `${match[3]}/${match[2]}/${match[1]}`;
}

function normalizeVietnameseText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/gi, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
