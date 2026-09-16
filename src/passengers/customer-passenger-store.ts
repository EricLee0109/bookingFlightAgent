import fs from 'node:fs';
import path from 'node:path';
import { normalizePassengerText } from './passenger-normalization';
import type {
  CustomerPassengerInfo,
  CustomerPassengerProfile,
} from './customer-passenger-types';

const Database = require('better-sqlite3') as BetterSqliteDatabaseConstructor;

/** The customer store shares the existing SQLite file but owns a new table. */
export const CUSTOMER_PASSENGER_DB_PATH = path.resolve(
  process.cwd(),
  'data/passengers/passengers.sqlite',
);

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 5;
const LIKE_ESCAPE_CHARACTER = '^';

type BetterSqliteDatabaseConstructor = new (
  dbPath: string,
) => BetterSqliteDatabase;

type BetterSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  close(): void;
};

type BetterSqliteStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
};

type CustomerPassengerRow = {
  id: number;
  owner_telegram_user_id: number;
  operation_key: string;
  last_name: string;
  first_name: string;
  gender: 'M' | 'F';
  dob: string;
  normalized_last_name: string;
  normalized_first_name: string;
  normalized_full_name: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type CustomerPassengerListOptions = {
  query?: string;
  page?: number;
  pageSize?: number;
};

type ValidatedCustomerPassengerInfo = {
  info: CustomerPassengerInfo;
  normalizedLastName: string;
  normalizedFirstName: string;
  normalizedFullName: string;
};

/** Indicates that a profile is not owned by the Telegram user in the call. */
export class CustomerPassengerOwnerMismatchError extends Error {
  readonly code = 'CUSTOMER_PASSENGER_OWNER_MISMATCH';

  constructor() {
    super('Customer passenger profile is not owned by this Telegram user.');
    this.name = 'CustomerPassengerOwnerMismatchError';
  }
}

/** Indicates that a write used a stale optimistic-concurrency version. */
export class CustomerPassengerVersionConflictError extends Error {
  readonly code = 'CUSTOMER_PASSENGER_VERSION_CONFLICT';

  constructor() {
    super('Customer passenger profile version conflict.');
    this.name = 'CustomerPassengerVersionConflictError';
  }
}

/**
 * SQLite-backed profiles created by a Telegram customer.
 *
 * The store deliberately does not import or instantiate PassengerStore. Its
 * migration only creates `customer_passenger_profiles`, leaving the legacy
 * passenger cache and its schema untouched.
 */
export class CustomerPassengerStore {
  private readonly db: BetterSqliteDatabase;
  private closed = false;

  constructor(dbPath = CUSTOMER_PASSENGER_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
  }

  /** Creates the customer table and its indexes, safely on repeated calls. */
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customer_passenger_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_telegram_user_id INTEGER NOT NULL,
        operation_key TEXT NOT NULL,
        last_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        gender TEXT NOT NULL CHECK (gender IN ('M', 'F')),
        dob TEXT NOT NULL,
        normalized_last_name TEXT NOT NULL,
        normalized_first_name TEXT NOT NULL,
        normalized_full_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_telegram_user_id, operation_key)
      );

      CREATE INDEX IF NOT EXISTS idx_customer_passenger_profiles_owner
        ON customer_passenger_profiles(owner_telegram_user_id, id);

      CREATE INDEX IF NOT EXISTS idx_customer_passenger_profiles_owner_name
        ON customer_passenger_profiles(
          owner_telegram_user_id,
          normalized_full_name
        );
    `);
  }

  /** Reads one profile only when it belongs to the requesting owner. */
  get(ownerTelegramUserId: number, id: number): CustomerPassengerProfile | null {
    const ownerId = validateOwnerId(ownerTelegramUserId);
    const profileId = validatePositiveInteger(id, 'id');
    this.migrate();

    const row = this.db
      .prepare(
        `
        SELECT *
        FROM customer_passenger_profiles
        WHERE owner_telegram_user_id = ? AND id = ?;
      `,
      )
      .get(ownerId, profileId) as CustomerPassengerRow | undefined;

    return row ? mapCustomerPassengerRow(row) : null;
  }

  /**
   * Lists one owner's profiles with a small bounded page size.
   *
   * A page beyond the available range returns an empty page with the real
   * total. Invalid page values are rejected before they can become SQLite
   * offsets. A requested page size above the bound is capped at five.
   */
  list(
    ownerTelegramUserId: number,
    options: CustomerPassengerListOptions = {},
  ): { profiles: CustomerPassengerProfile[]; total: number; page: number } {
    const ownerId = validateOwnerId(ownerTelegramUserId);
    const page = validatePositiveInteger(options.page ?? 1, 'page');
    const requestedPageSize = validatePositiveInteger(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      'pageSize',
    );
    const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
    const normalizedQuery = normalizeListQuery(options.query);

    this.migrate();

    // A non-empty query made entirely of punctuation must not degrade into an
    // unfiltered LIKE query. Existing passenger normalization defines what is
    // searchable, so there are simply no matches in this case.
    if (normalizedQuery === '') {
      return { profiles: [], total: 0, page };
    }

    const where = ['owner_telegram_user_id = ?'];
    const params: unknown[] = [ownerId];

    if (normalizedQuery !== undefined) {
      const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
      where.push(`
        (
          normalized_last_name LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'
          OR normalized_first_name LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'
          OR normalized_full_name LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'
        )
      `);
      params.push(pattern, pattern, pattern);
    }

    const whereSql = where.join(' AND ');
    const countRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS total
        FROM customer_passenger_profiles
        WHERE ${whereSql};
      `,
      )
      .get(...params) as { total: number };
    const total = Number(countRow.total);

    if (total === 0) {
      return { profiles: [], total, page };
    }

    const lastPage = Math.ceil(total / pageSize);
    if (page > lastPage) {
      return { profiles: [], total, page };
    }

    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) {
      return { profiles: [], total, page };
    }

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM customer_passenger_profiles
        WHERE ${whereSql}
        ORDER BY id ASC
        LIMIT ? OFFSET ?;
      `,
      )
      .all(...params, pageSize, offset) as CustomerPassengerRow[];

    return {
      profiles: rows.map(mapCustomerPassengerRow),
      total,
      page,
    };
  }

  /**
   * Creates a profile or returns the existing profile for this owner's
   * operation key. Names are intentionally never used as a merge key.
   */
  create(
    ownerTelegramUserId: number,
    info: CustomerPassengerInfo,
    operationKey: string,
  ): CustomerPassengerProfile {
    const ownerId = validateOwnerId(ownerTelegramUserId);
    const validatedInfo = validateCustomerPassengerInfo(info);
    const key = validateOperationKey(operationKey);
    this.migrate();

    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
        INSERT INTO customer_passenger_profiles (
          owner_telegram_user_id,
          operation_key,
          last_name,
          first_name,
          gender,
          dob,
          normalized_last_name,
          normalized_first_name,
          normalized_full_name,
          version,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (owner_telegram_user_id, operation_key)
        DO UPDATE SET operation_key = customer_passenger_profiles.operation_key
        RETURNING *;
      `,
      )
      .get(
        ownerId,
        key,
        validatedInfo.info.lastName,
        validatedInfo.info.firstName,
        validatedInfo.info.gender,
        validatedInfo.info.dob,
        validatedInfo.normalizedLastName,
        validatedInfo.normalizedFirstName,
        validatedInfo.normalizedFullName,
        now,
        now,
      ) as CustomerPassengerRow;

    return mapCustomerPassengerRow(row);
  }

  /**
   * Updates one owned profile using optimistic concurrency.
   *
   * The owner and expected version are part of the UPDATE predicate, so a
   * stale or cross-owner request cannot overwrite another profile.
   */
  update(
    ownerTelegramUserId: number,
    id: number,
    expectedVersion: number,
    info: CustomerPassengerInfo,
  ): CustomerPassengerProfile {
    const ownerId = validateOwnerId(ownerTelegramUserId);
    const profileId = validatePositiveInteger(id, 'id');
    const version = validatePositiveInteger(expectedVersion, 'expectedVersion');
    const validatedInfo = validateCustomerPassengerInfo(info);
    this.migrate();

    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
        UPDATE customer_passenger_profiles
        SET
          last_name = ?,
          first_name = ?,
          gender = ?,
          dob = ?,
          normalized_last_name = ?,
          normalized_first_name = ?,
          normalized_full_name = ?,
          version = version + 1,
          updated_at = ?
        WHERE owner_telegram_user_id = ?
          AND id = ?
          AND version = ?
        RETURNING *;
      `,
      )
      .get(
        validatedInfo.info.lastName,
        validatedInfo.info.firstName,
        validatedInfo.info.gender,
        validatedInfo.info.dob,
        validatedInfo.normalizedLastName,
        validatedInfo.normalizedFirstName,
        validatedInfo.normalizedFullName,
        now,
        ownerId,
        profileId,
        version,
      ) as CustomerPassengerRow | undefined;

    if (row) {
      return mapCustomerPassengerRow(row);
    }

    const ownedProfile = this.db
      .prepare(
        `
        SELECT id
        FROM customer_passenger_profiles
        WHERE owner_telegram_user_id = ? AND id = ?;
      `,
      )
      .get(ownerId, profileId);

    if (!ownedProfile) {
      throw new CustomerPassengerOwnerMismatchError();
    }

    throw new CustomerPassengerVersionConflictError();
  }

  /** Closes the SQLite handle; repeated close calls are harmless. */
  close() {
    if (this.closed) {
      return;
    }

    this.db.close();
    this.closed = true;
  }
}

function mapCustomerPassengerRow(
  row: CustomerPassengerRow,
): CustomerPassengerProfile {
  return {
    id: row.id,
    ownerTelegramUserId: row.owner_telegram_user_id,
    lastName: row.last_name,
    firstName: row.first_name,
    gender: row.gender,
    dob: row.dob,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateOwnerId(value: number) {
  return validatePositiveInteger(value, 'ownerTelegramUserId');
}

function validatePositiveInteger(value: number, fieldName: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be a safe positive integer.`);
  }

  return value;
}

function validateOperationKey(value: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('operationKey must be a non-empty string.');
  }

  return value.trim();
}

function validateCustomerPassengerInfo(
  input: CustomerPassengerInfo,
): ValidatedCustomerPassengerInfo {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Customer passenger information is required.');
  }

  const lastName = normalizeStoredName(input.lastName, 'lastName');
  const firstName = normalizeStoredName(input.firstName, 'firstName');

  if (input.gender !== 'M' && input.gender !== 'F') {
    throw new TypeError('gender must be M or F.');
  }

  const dob = validateDateOfBirth(input.dob);
  const normalizedLastName = normalizePassengerText(lastName);
  const normalizedFirstName = normalizePassengerText(firstName);
  const normalizedFullName = normalizePassengerText(
    `${lastName} ${firstName}`,
  );

  if (!normalizedLastName || !normalizedFirstName || !normalizedFullName) {
    throw new TypeError('Passenger names must contain searchable text.');
  }

  return {
    info: {
      lastName,
      firstName,
      gender: input.gender,
      dob,
    },
    normalizedLastName,
    normalizedFirstName,
    normalizedFullName,
  };
}

function normalizeStoredName(value: string, fieldName: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }

  return value.trim().replace(/\s+/g, ' ');
}

function validateDateOfBirth(value: string) {
  if (typeof value !== 'string') {
    throw new TypeError('dob must be a full ISO date.');
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new TypeError('dob must be a full ISO date.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new TypeError('dob must be a real calendar date.');
  }

  return value;
}

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function normalizeListQuery(query: string | undefined) {
  if (query === undefined) {
    return undefined;
  }

  if (typeof query !== 'string') {
    throw new TypeError('query must be a string.');
  }

  if (query.trim() === '') {
    return undefined;
  }

  return normalizePassengerText(query);
}

function escapeLikePattern(value: string) {
  return value.replace(
    new RegExp(`[${LIKE_ESCAPE_CHARACTER}%_]`, 'g'),
    (character) => `${LIKE_ESCAPE_CHARACTER}${character}`,
  );
}
