import fs from 'node:fs/promises';
import path from 'node:path';

export type LocalLogLevel = 'info' | 'warn' | 'error';

export type LocalLogEntry = {
  timestamp: string;
  level: LocalLogLevel;
  event: string;
  caseId?: string;
  message: string;
  meta?: Record<string, unknown>;
};

const LOG_DIR = path.resolve(process.cwd(), 'data/logs');
const TEXT_LOG_PATH = path.join(LOG_DIR, 'app.log');
const JSON_LOG_PATH = path.join(LOG_DIR, 'app.logs.json');

/**
 * Appends a local log entry to text and JSON log files.
 *
 * This store owns local logging only. It keeps the lean internal agent observable
 * without introducing PostgreSQL, Redis, or hosted log storage.
 */
export async function appendLocalLog(
  entry: Omit<LocalLogEntry, 'timestamp'>,
) {
  const logEntry: LocalLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  await fs.mkdir(LOG_DIR, {
    recursive: true,
  });

  await fs.appendFile(TEXT_LOG_PATH, formatTextLog(logEntry));
  await appendJsonLog(logEntry);
}

function formatTextLog(entry: LocalLogEntry) {
  const casePart = entry.caseId ? ` case=${entry.caseId}` : '';
  const metaPart = entry.meta ? ` meta=${JSON.stringify(entry.meta)}` : '';

  return `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.event}${casePart} ${entry.message}${metaPart}\n`;
}

async function appendJsonLog(entry: LocalLogEntry) {
  let entries: LocalLogEntry[] = [];

  try {
    entries = JSON.parse(await fs.readFile(JSON_LOG_PATH, 'utf8'));
  } catch {
    entries = [];
  }

  entries.push(entry);

  await fs.writeFile(JSON_LOG_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}
