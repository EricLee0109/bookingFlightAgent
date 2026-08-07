import { type Page } from 'playwright';
import { createOneBookingBrowserSession } from '../automation/1booking/browser';
import { openMatchingFlightPassengerForm } from '../automation/1booking/flight-selection';
import {
  confirmPassengerHold,
  fillAndAssertPassengerInformation,
  PostSubmitHoldError,
} from '../automation/1booking/hold-booking';
import {
  fillAndAssertHoldContactInformation,
  readOneBookingHoldContactInfoFromEnv,
} from '../automation/1booking/hold-contact';
import { extractHeldBookingPnr } from '../automation/1booking/pnr';
import {
  takeCaseUiScreenshot,
  type OneBookingUiScreenshotCheckpoint,
} from '../automation/1booking/screenshots';
import { type SelectMatchingFlightInput } from '../contracts/flight';
import { PassengerStore } from '../passengers/passenger-store';
import {
  readLocalFlightCase,
  updateLocalFlightCase,
  type LocalFlightCase,
} from '../storage/local-case-store';
import { appendLocalLog } from '../storage/local-log-store';
import { runWithAutomationLock } from '../utils/automation-lock';
import { OneBookingAuthRefreshRetryController } from './onebooking-auth-refresh-retry';

export type PassengerHoldAutomationResult =
  | {
      ok: true;
      caseId: string;
      pnrCode: string | null;
      pnrWarning?: string;
      authRefreshed?: boolean;
    }
  | {
      ok: false;
      reason: 'needs_input';
      caseId: string;
      missingFields: ['dob'];
      message: string;
      errorScreenshotPath: null;
      authRefreshed?: boolean;
    }
  | {
      ok: false;
      reason: 'automation_failed';
      caseId: string;
      message: string;
      errorScreenshotPath: string | null;
      authRefreshed?: boolean;
    }
  | {
      ok: false;
      reason: 'needs_review';
      caseId: string;
      message: string;
      errorScreenshotPath: string | null;
      authRefreshed?: boolean;
    };

export type PassengerHoldAutomationOptions = {
  onAuthRefresh?: () => Promise<void>;
};

const MAX_ONE_BOOKING_HOLD_ATTEMPTS = 2;

/**
 * Reruns the saved flight selection, fills validated passenger information,
 * asserts the browser form, and confirms the 1Booking hold action.
 *
 * This service owns browser lifecycle and local status updates. It does not
 * parse Telegram text and it never sends Telegram messages.
 */
export async function fillPassengerAndHoldOneBookingCase(
  caseId: string,
  options: PassengerHoldAutomationOptions = {},
): Promise<PassengerHoldAutomationResult> {
  try {
    return await runWithAutomationLock('Giữ chỗ', () =>
      fillPassengerAndHoldOneBookingCaseUnlocked(caseId, options),
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'automation_failed',
      caseId,
      message:
        error instanceof Error ? error.message : 'Unknown automation lock error.',
      errorScreenshotPath: null,
    };
  }
}

/**
 * Executes the passenger hold flow after the public service acquires its lock.
 */
async function fillPassengerAndHoldOneBookingCaseUnlocked(
  caseId: string,
  options: PassengerHoldAutomationOptions,
): Promise<PassengerHoldAutomationResult> {
  let flightCase = await readLocalFlightCase(caseId);

  if (!flightCase) {
    return createFailure(caseId, `Cannot hold booking. Case ${caseId} was not found.`);
  }

  const existingHoldResult = getExistingHoldResult(flightCase);

  if (existingHoldResult) {
    return existingHoldResult;
  }

  const missingFields = getMissingHoldPassengerFields(flightCase);

  if (missingFields.length > 0) {
    await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_NEEDS_REVIEW',
      passengerErrorMessage: `Missing hold passenger fields: ${missingFields.join(', ')}`,
    });

    return {
      ok: false,
      reason: 'needs_input',
      caseId,
      missingFields: missingFields as ['dob'],
      message:
        'Vietnam Airlines requires passenger DOB before automatic hold booking.',
      errorScreenshotPath: null,
    };
  }

  const validationError = validateHoldCase(flightCase);

  if (validationError) {
    return createFailure(caseId, validationError);
  }

  let holdContactInfo;

  try {
    holdContactInfo = readOneBookingHoldContactInfoFromEnv();
  } catch (error) {
    return createFailure(
      caseId,
      error instanceof Error
        ? error.message
        : 'Missing 1Booking hold contact info.',
    );
  }

  const authRetry = new OneBookingAuthRefreshRetryController({
    caseId,
    onAuthRefresh: options.onAuthRefresh,
  });

  for (let attempt = 1; attempt <= MAX_ONE_BOOKING_HOLD_ATTEMPTS; attempt++) {
    const { browser, page } = await createOneBookingBrowserSession();
    let holdStarted = false;
    let holdSubmitted = false;

    try {
      flightCase = await updateLocalFlightCase(flightCase, {
        status: 'FILL_PASSENGER_RUNNING',
        holdErrorScreenshotPath: undefined,
        errorMessage: undefined,
      });

      await openMatchingFlightPassengerForm(
        page,
        flightCase.searchInput!,
        buildSavedFlightSelectionInput(flightCase),
      );
      await fillAndAssertPassengerInformation(
        page,
        flightCase.attachedPassengerInfo!,
      );
      await fillAndAssertHoldContactInformation(page, holdContactInfo);
      await captureHoldUiScreenshot(page, caseId, 'passenger-form-filled');

      flightCase = await updateLocalFlightCase(flightCase, {
        status: 'FILL_PASSENGER_DONE',
      });
      flightCase = await updateLocalFlightCase(flightCase, {
        status: 'READY_TO_HOLD',
      });
      flightCase = await updateLocalFlightCase(flightCase, {
        status: 'HOLD_RUNNING',
      });
      holdStarted = true;

      const heldOrder = await confirmPassengerHold(
        page,
        {
          passengerInfo: flightCase.attachedPassengerInfo!,
          flightNumber: flightCase.selectedFlight!.flightNumber,
        },
        {
          async onReviewReady() {
            await captureHoldUiScreenshot(page, caseId, 'hold-review');
          },
          async onSubmitted() {
            holdSubmitted = true;
            flightCase = await patchPersistedFlightCase(caseId, {
              holdSubmittedAt: new Date().toISOString(),
            });
            await appendLocalLog({
              level: 'info',
              event: 'one_booking_hold_submitted',
              caseId,
              message: 'Submitted final 1Booking hold action.',
            });
          },
          async onLoadingObserved(observedAt) {
            await patchPersistedFlightCase(caseId, {
              holdLoadingObservedAt: observedAt,
            });
            await appendLocalLog({
              level: 'info',
              event: 'one_booking_hold_loading_observed',
              caseId,
              message: 'Observed transient 1Booking hold loading modal.',
            });
          },
          async onSuccessModalObserved(observedAt) {
            await patchPersistedFlightCase(caseId, {
              holdSuccessModalObservedAt: observedAt,
            });
            await appendLocalLog({
              level: 'info',
              event: 'one_booking_hold_success_modal_observed',
              caseId,
              message: 'Observed transient 1Booking hold success modal.',
            });
          },
        },
      );

      await captureHoldUiScreenshot(page, caseId, 'hold-success');
      flightCase = await patchPersistedFlightCase(caseId, {
        status: 'HOLD_SUCCESS',
        holdSucceededAt: new Date().toISOString(),
        orderId: heldOrder.orderId,
        orderDetailUrl: heldOrder.orderDetailUrl,
        holdErrorScreenshotPath: undefined,
        errorMessage: undefined,
      });
      await appendLocalLog({
        level: 'info',
        event: 'one_booking_hold_order_page_confirmed',
        caseId,
        message: 'Confirmed durable 1Booking held-order page.',
        meta: heldOrder,
      });

      const store = new PassengerStore();
      let pnrWarning: string | undefined;

      try {
        store.markCasePassengerSuccessfulHold(caseId);
      } catch (error) {
        pnrWarning = formatSecondaryHoldWarning(
          'The booking was held, but the local passenger status could not be updated.',
          error,
        );
      } finally {
        store.close();
      }

      try {
        const pnrCode =
          heldOrder.pnrCode ??
          (await extractHeldBookingPnr(
            page,
            flightCase.selectedFlight!.flightNumber,
          ));

        flightCase = await patchPersistedFlightCase(caseId, {
          status: getPnrExtractionStatus(pnrCode),
          pnrCode,
          pnrExtractedAt: new Date().toISOString(),
          pnrErrorMessage: undefined,
        });
        await appendLocalLog({
          level: 'info',
          event: 'one_booking_pnr_extracted',
          caseId,
          message: 'Extracted held-booking PNR.',
          meta: {
            pnrCode,
          },
        });

        return {
          ok: true,
          caseId,
          pnrCode,
          pnrWarning,
          authRefreshed: authRetry.authRefreshed || undefined,
        };
      } catch (error) {
        const pnrErrorMessage =
          error instanceof Error ? error.message : 'Unknown PNR extraction error.';
        const extractionWarning = formatSecondaryHoldWarning(
          'The booking was held, but PNR extraction failed. Please check the existing 1Booking order manually.',
          error,
        );

        await patchPersistedFlightCase(caseId, {
          status: getPnrExtractionStatus(null),
          pnrErrorMessage,
        });
        await appendLocalLog({
          level: 'warn',
          event: 'one_booking_pnr_extract_failed',
          caseId,
          message: pnrErrorMessage,
        });

        return {
          ok: true,
          caseId,
          pnrCode: null,
          pnrWarning: joinWarnings(pnrWarning, extractionWarning),
          authRefreshed: authRetry.authRefreshed || undefined,
        };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown hold automation error.';
      let errorScreenshotPath: string | null = null;

      try {
        errorScreenshotPath = await takeCaseUiScreenshot(
          page,
          caseId,
          'hold-failed',
        );
      } catch {
        errorScreenshotPath = null;
      }

      if (
        attempt < MAX_ONE_BOOKING_HOLD_ATTEMPTS &&
        (await authRetry.refreshIfAuthExpired(error, {
          irreversible: holdSubmitted,
        }))
      ) {
        await browser.close();
        continue;
      }

      const failureStatus = getHoldAutomationFailureStatus(
        error,
        holdSubmitted,
        holdStarted,
      );

      await patchPersistedFlightCase(caseId, {
        status: failureStatus,
        holdErrorScreenshotPath: errorScreenshotPath ?? undefined,
        errorMessage: message,
      });

      if (failureStatus === 'HOLD_NEEDS_REVIEW') {
        await appendLocalLog({
          level: 'warn',
          event: 'one_booking_hold_needs_review',
          caseId,
          message,
          meta:
            error instanceof PostSubmitHoldError
              ? {
                  checkpoint: error.checkpoint,
                  originalCauseMessage: error.originalCauseMessage,
                  currentUrl: error.currentUrl,
                  errorScreenshotPath,
                }
              : {
                  errorScreenshotPath,
                },
        });
        return createNeedsReview(
          caseId,
          message,
          errorScreenshotPath,
          authRetry.authRefreshed,
        );
      }

      return createFailure(
        caseId,
        message,
        errorScreenshotPath,
        authRetry.authRefreshed,
      );
    } finally {
      await browser.close().catch(() => null);
    }
  }

  return createFailure(
    caseId,
    'Unknown 1Booking hold automation error after auth retry.',
    null,
    authRetry.authRefreshed,
  );
}

/**
 * Applies one case patch against the latest local snapshot.
 *
 * Transient modal observers run concurrently with terminal-page verification,
 * so each patch reads fresh state before writing to avoid lost audit fields.
 */
async function patchPersistedFlightCase(
  caseId: string,
  patch: Partial<LocalFlightCase>,
) {
  const currentCase = await readLocalFlightCase(caseId);

  if (!currentCase) {
    throw new Error(`Cannot update missing local case ${caseId}.`);
  }

  return updateLocalFlightCase(currentCase, patch);
}

type HoldUiScreenshotCheckpoint = Extract<
  OneBookingUiScreenshotCheckpoint,
  'passenger-form-filled' | 'hold-review' | 'hold-success'
>;

/**
 * Persists UI evidence without allowing screenshot failures to block a booking.
 */
async function captureHoldUiScreenshot(
  page: Page,
  caseId: string,
  checkpoint: HoldUiScreenshotCheckpoint,
) {
  const currentUrl = page.url();

  try {
    const screenshotPath = await takeCaseUiScreenshot(page, caseId, checkpoint);
    const patch: Partial<LocalFlightCase> =
      checkpoint === 'passenger-form-filled'
        ? { passengerFormScreenshotPath: screenshotPath }
        : checkpoint === 'hold-review'
          ? { holdReviewScreenshotPath: screenshotPath }
          : { holdSuccessScreenshotPath: screenshotPath };

    await patchPersistedFlightCase(caseId, patch);
    await appendLocalLog({
      level: 'info',
      event: 'one_booking_ui_screenshot_captured',
      caseId,
      message: `Captured 1Booking UI checkpoint "${checkpoint}".`,
      meta: {
        checkpoint,
        screenshotPath,
        url: currentUrl,
      },
    });

    return screenshotPath;
  } catch (error) {
    await appendLocalLog({
      level: 'warn',
      event: 'one_booking_ui_screenshot_failed',
      caseId,
      message:
        error instanceof Error
          ? error.message
          : `Could not capture 1Booking UI checkpoint "${checkpoint}".`,
      meta: {
        checkpoint,
        url: currentUrl,
      },
    }).catch(() => null);

    return null;
  }
}

/**
 * Prevents rerunning a hold flow after an irreversible submission or success.
 */
function getExistingHoldResult(
  flightCase: LocalFlightCase,
): PassengerHoldAutomationResult | null {
  if (flightCase.status === 'PNR_EXTRACTED') {
    return {
      ok: true,
      caseId: flightCase.caseId,
      pnrCode: flightCase.pnrCode ?? null,
    };
  }

  if (flightCase.status === 'HOLD_SUCCESS') {
    return {
      ok: true,
      caseId: flightCase.caseId,
      pnrCode: flightCase.pnrCode ?? null,
      pnrWarning:
        flightCase.pnrErrorMessage ??
        'The booking was already held. Please check the existing 1Booking order manually for its PNR.',
    };
  }

  if (flightCase.status === 'HOLD_NEEDS_REVIEW' || flightCase.holdSubmittedAt) {
    return createNeedsReview(
      flightCase.caseId,
      'The hold action may already have been submitted. Please review the existing 1Booking order before retrying.',
    );
  }

  return null;
}

/**
 * Maps browser failures to safe lifecycle states around the final hold click.
 */
export function getHoldAutomationFailureStatus(
  error: unknown,
  holdSubmitted: boolean,
  holdStarted: boolean,
) {
  if (error instanceof PostSubmitHoldError || holdSubmitted) {
    return 'HOLD_NEEDS_REVIEW' as const;
  }

  return holdStarted ? ('HOLD_FAILED' as const) : ('FILL_PASSENGER_FAILED' as const);
}

/**
 * Keeps a proven hold successful even when secondary PNR extraction fails.
 */
export function getPnrExtractionStatus(pnrCode: string | null) {
  return pnrCode ? ('PNR_EXTRACTED' as const) : ('HOLD_SUCCESS' as const);
}

/**
 * Validates saved case state before launching Playwright.
 */
function validateHoldCase(flightCase: LocalFlightCase) {
  if (!flightCase.searchInput) {
    return `Cannot hold booking. Case ${flightCase.caseId} has no saved search input.`;
  }

  if (!flightCase.selectedFlight) {
    return `Cannot hold booking. Case ${flightCase.caseId} has no selected flight.`;
  }

  if (!flightCase.attachedPassengerInfo) {
    return `Cannot hold booking. Case ${flightCase.caseId} has no passenger_ready information.`;
  }

  if (!flightCase.attachedPassengerInfo.gender) {
    return 'Cannot hold booking. Passenger gender is required.';
  }

  if (
    !flightCase.attachedPassengerInfo.lastName.trim() ||
    !flightCase.attachedPassengerInfo.firstName.trim()
  ) {
    return 'Cannot hold booking. Passenger full name is required.';
  }

  return null;
}

/**
 * Returns airline-specific passenger fields required before browser launch.
 *
 * DOB remains optional for the lean MVP except on Vietnam Airlines (`VN`).
 */
export function getMissingHoldPassengerFields(
  flightCase: Pick<LocalFlightCase, 'selectedFlight' | 'attachedPassengerInfo'>,
) {
  if (
    flightCase.selectedFlight?.airlineCode === 'VN' &&
    !flightCase.attachedPassengerInfo?.dob
  ) {
    return ['dob'] as ['dob'];
  }

  return [] as [];
}

/**
 * Maps the saved live UI selection back into the exact rerun selection input.
 */
function buildSavedFlightSelectionInput(
  flightCase: LocalFlightCase,
): SelectMatchingFlightInput {
  const selectedFlight = flightCase.selectedFlight!;

  return {
    caseId: flightCase.caseId,
    airlineCode: selectedFlight.airlineCode,
    airlineName: selectedFlight.airlineName,
    departureTime: selectedFlight.departureTime,
    bookingClass: selectedFlight.bookingClass,
  };
}

function createFailure(
  caseId: string,
  message: string,
  errorScreenshotPath: string | null = null,
  authRefreshed = false,
): PassengerHoldAutomationResult {
  return {
    ok: false,
    reason: 'automation_failed',
    caseId,
    message,
    errorScreenshotPath,
    authRefreshed: authRefreshed || undefined,
  };
}

function createNeedsReview(
  caseId: string,
  message: string,
  errorScreenshotPath: string | null = null,
  authRefreshed = false,
): PassengerHoldAutomationResult {
  return {
    ok: false,
    reason: 'needs_review',
    caseId,
    message,
    errorScreenshotPath,
    authRefreshed: authRefreshed || undefined,
  };
}

function formatSecondaryHoldWarning(message: string, error: unknown) {
  return [
    message,
    error instanceof Error ? error.message : 'Unknown secondary hold error.',
  ].join(' ');
}

function joinWarnings(...warnings: Array<string | undefined>) {
  return warnings.filter(Boolean).join(' ');
}
