import fs from 'node:fs/promises';
import path from 'node:path';
import { type SearchFlightsInput } from '../automation/1booking/flight-search';
import { type ParsedFlightRequest } from '../contracts/flight';

export type LocalFlightCaseStatus =
  | 'received'
  | 'parsed'
  | 'needs_input'
  | 'searching'
  | 'completed'
  | 'failed';

export type LocalFlightCase = {
  caseId: string;
  status: LocalFlightCaseStatus;
  rawMessage: string;
  parsedRequest?: ParsedFlightRequest;
  searchInput?: SearchFlightsInput;
  flightCount?: number;
  screenshotPath?: string;
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
