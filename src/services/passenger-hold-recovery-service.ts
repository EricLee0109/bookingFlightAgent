import { isValidPnrCode } from '../automation/1booking/pnr';
import { PassengerStore } from '../passengers/passenger-store';
import {
  readLocalFlightCase,
  updateLocalFlightCase,
  type LocalFlightCase,
} from '../storage/local-case-store';
import { appendLocalLog } from '../storage/local-log-store';

export type RecoverHeldBookingInput = {
  caseId: string;
  pnrCode: string;
};

export type RecoverHeldBookingResult =
  | {
      ok: true;
      caseId: string;
      pnrCode: string;
    }
  | {
      ok: false;
      message: string;
    };

type PassengerHoldRecoveryDependencies = {
  readCase?: typeof readLocalFlightCase;
  updateCase?: typeof updateLocalFlightCase;
  markPassengerSuccessfulHold?: (caseId: string) => void;
  appendLog?: typeof appendLocalLog;
  now?: () => string;
};

/**
 * Reconciles one manually reviewed held booking without reopening Playwright.
 *
 * This service is intentionally local-only. It never searches flights, never
 * submits another hold, and never clicks ticket issuance actions.
 */
export async function recoverHeldBookingCase(
  input: RecoverHeldBookingInput,
  dependencies: PassengerHoldRecoveryDependencies = {},
): Promise<RecoverHeldBookingResult> {
  const readCase = dependencies.readCase ?? readLocalFlightCase;
  const updateCase = dependencies.updateCase ?? updateLocalFlightCase;
  const appendLog = dependencies.appendLog ?? appendLocalLog;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const pnrCode = input.pnrCode.trim().toUpperCase();

  if (!isValidPnrCode(pnrCode)) {
    return {
      ok: false,
      message: `PNR "${input.pnrCode}" không hợp lệ. PNR phải gồm đúng 6 ký tự chữ hoặc số.`,
    };
  }

  const flightCase = await readCase(input.caseId);

  if (!flightCase) {
    return {
      ok: false,
      message: `Không tìm thấy case ${input.caseId}.`,
    };
  }

  const validationError = validateRecoverableHoldCase(flightCase);

  if (validationError) {
    return {
      ok: false,
      message: validationError,
    };
  }

  const markPassengerSuccessfulHold =
    dependencies.markPassengerSuccessfulHold ??
    ((caseId: string) => {
      const store = new PassengerStore();

      try {
        store.markCasePassengerSuccessfulHold(caseId);
      } finally {
        store.close();
      }
    });

  markPassengerSuccessfulHold(input.caseId);

  await updateCase(flightCase, {
    status: 'PNR_EXTRACTED',
    pnrCode,
    pnrExtractedAt: now(),
    holdRecoveredAt: now(),
    holdSucceededAt: flightCase.holdSucceededAt ?? now(),
    pnrErrorMessage: undefined,
    holdErrorScreenshotPath: undefined,
    errorMessage: undefined,
  });
  await appendLog({
    level: 'info',
    event: 'one_booking_hold_recovered',
    caseId: input.caseId,
    message: 'Recovered manually reviewed held booking with operator-supplied PNR.',
    meta: {
      pnrCode,
    },
  });

  return {
    ok: true,
    caseId: input.caseId,
    pnrCode,
  };
}

/**
 * Allows recovery only for uncertain or proven holds that still lack a PNR.
 */
export function validateRecoverableHoldCase(flightCase: LocalFlightCase) {
  if (flightCase.pnrCode) {
    return `Case ${flightCase.caseId} đã có PNR ${flightCase.pnrCode}.`;
  }

  if (
    flightCase.status !== 'HOLD_NEEDS_REVIEW' &&
    flightCase.status !== 'HOLD_SUCCESS'
  ) {
    return `Case ${flightCase.caseId} không ở trạng thái cần recover hold.`;
  }

  return null;
}
