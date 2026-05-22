import fs from 'node:fs/promises';
import path from 'node:path';
import { type SearchFlightsInput } from '../automation/1booking/flight-search';
import { type ParsedFlightRequest, type SelectedFlight } from '../contracts/flight';
import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';

export type LocalFlightCaseStatus =
  | 'received'
  | 'parsed'
  | 'needs_input'
  | 'searching'
  | 'completed'
  | 'selecting'
  | 'selected'
  | 'selection_failed'
  | 'failed';

export type LocalFlightCase = {
  caseId: string;
  status: LocalFlightCaseStatus;
  rawMessage: string;
  parsedRequest?: ParsedFlightRequest;
  searchInput?: SearchFlightsInput;
  flightCount?: number;
  screenshotPath?: string;
  screenshotPaths?: string[];
  selectedFlight?: SelectedFlight;
  selectionScreenshotPath?: string;
  selectionErrorMessage?: string;
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
    status: 'received',
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
