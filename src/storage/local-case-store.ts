import fs from 'node:fs/promises';
import path from 'node:path';
import { type FlightResultFilterSummary } from '../automation/1booking/flight-result-ranking';
import { type SearchFlightsInput } from '../automation/1booking/flight-search';
import { type ParsedFlightRequest, type SelectedFlight } from '../contracts/flight';
import { type ParsedPassengerMessage } from '../contracts/passenger';
import {
  type PassengerInfo,
  type PassengerProfile,
} from '../passengers/passenger-types';
import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';

export type LocalFlightCaseStatus =
  | 'CASE_CREATED'
  | 'SEARCH_REQUESTED'
  | 'SEARCH_RUNNING'
  | 'SEARCH_DONE'
  | 'OPTIONS_SENT'
  | 'CUSTOMER_SELECTED_OPTION'
  | 'OPTION_MATCHED'
  | 'AWAITING_PASSENGER_INFO'
  | 'PASSENGER_INFO_RECEIVED'
  | 'PASSENGER_INFO_PARSED'
  | 'PASSENGER_INFO_NEEDS_REVIEW'
  | 'PASSENGER_INFO_CONFIRMED'
  | 'FILL_PASSENGER_RUNNING'
  | 'FILL_PASSENGER_DONE'
  | 'READY_TO_HOLD'
  | 'HOLD_RUNNING'
  | 'HOLD_SUCCESS'
  | 'HOLD_NEEDS_REVIEW'
  | 'PNR_EXTRACTED'
  | 'NEEDS_INPUT'
  | 'SEARCH_FAILED'
  | 'OPTION_MATCH_FAILED'
  | 'PASSENGER_INFO_FAILED'
  | 'FILL_PASSENGER_FAILED'
  | 'HOLD_FAILED'
  | 'PNR_EXTRACT_FAILED'
  | 'CASE_FAILED';

/**
 * Local case memory for one Telegram flight request.
 *
 * Status lifecycle is intentionally explicit so future phases can resume from
 * search, option matching, passenger info, form fill, hold, and PNR extraction.
 *
 * Important:
 * - `FILL_PASSENGER_DONE` only means Playwright finished entering passenger data.
 * - It does not mean 1Booking has held the booking yet.
 * - The booking is held only after `HOLD_SUCCESS`.
 */
export type LocalFlightCase = {
  caseId: string;
  status: LocalFlightCaseStatus;
  rawMessage: string;
  parsedRequest?: ParsedFlightRequest;
  searchInput?: SearchFlightsInput;
  flightCount?: number;
  displayedFlightCount?: number;
  flightResultFilter?: FlightResultFilterSummary;
  screenshotPath?: string;
  screenshotPaths?: string[];
  selectedFlight?: SelectedFlight;
  parsedPassengerMessage?: ParsedPassengerMessage;
  attachedPassenger?: PassengerProfile;
  attachedPassengerInfo?: PassengerInfo;
  selectionScreenshotPath?: string;
  passengerFormScreenshotPath?: string;
  holdReviewScreenshotPath?: string;
  holdSuccessScreenshotPath?: string;
  selectionErrorMessage?: string;
  passengerErrorMessage?: string;
  holdErrorScreenshotPath?: string;
  holdSubmittedAt?: string;
  holdSucceededAt?: string;
  holdLoadingObservedAt?: string;
  holdSuccessModalObservedAt?: string;
  holdRecoveredAt?: string;
  orderId?: string;
  orderDetailUrl?: string;
  pnrCode?: string;
  pnrExtractedAt?: string;
  pnrErrorMessage?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

const CASE_DIR = path.resolve(process.cwd(), 'data/cases');

/**
 * Generates a readable local case id for internal MVP case memory.
 *
 * This is file-based and not globally unique across machines. That is acceptable
 * for the lean local agent and can later be replaced by database ids.
 */
export function createLocalCaseId(now = new Date()) {
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const timePart = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  return `BK-${datePart}-${timePart}`;
}

/**
 * Creates a local case file when a Telegram request is received.
 *
 * This store owns local case memory only. Telegram and automation code should
 * update case state through this boundary.
 */
export async function createLocalFlightCase(rawMessage: string) {
  const now = new Date().toISOString();
  const flightCase: LocalFlightCase = {
    caseId: createLocalCaseId(),
    status: 'CASE_CREATED',
    rawMessage,
    createdAt: now,
    updatedAt: now,
  };

  await saveLocalFlightCase(flightCase);

  return flightCase;
}

/**
 * Writes a complete local case snapshot to disk.
 *
 * Each case is saved as one JSON file under `data/cases`.
 */
export async function saveLocalFlightCase(flightCase: LocalFlightCase) {
  await fs.mkdir(CASE_DIR, {
    recursive: true,
  });

  await fs.writeFile(
    getCasePath(flightCase.caseId),
    `${JSON.stringify(flightCase, null, 2)}\n`,
  );
}

/**
 * Reads one local flight case by id.
 *
 * Selection and hold-booking phases use this to continue from the previously
 * saved search input instead of asking the operator to repeat the full request.
 */
export async function readLocalFlightCase(caseId: string) {
  if (!BOOKING_CASE_REGEX.test(caseId)) {
    throw new Error(`Invalid local case id: ${caseId}`);
  }

  try {
    const rawCase = await fs.readFile(getCasePath(caseId), 'utf8');

    return JSON.parse(rawCase) as LocalFlightCase;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * Applies a partial update to a local case and persists it.
 *
 * This keeps case state changes consistent across parser, mapper, and
 * automation-service steps.
 */
export async function updateLocalFlightCase(
  flightCase: LocalFlightCase,
  patch: Partial<LocalFlightCase>,
) {
  const nextCase: LocalFlightCase = {
    ...flightCase,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await saveLocalFlightCase(nextCase);

  return nextCase;
}

function getCasePath(caseId: string) {
  return path.join(CASE_DIR, `${caseId}.json`);
}
