import fs from 'node:fs';
import path from 'node:path';
import { generatePassengerAliases } from './passenger-alias-generator';
import {
  buildPassengerFullName,
  normalizePassengerText,
} from './passenger-normalization';
import {
  type ConfidenceScoreInput,
  type OneBookingPassengerSuggestItem,
  type PassengerAliasInput,
  type PassengerProfile,
  type PassengerProfileInput,
} from './passenger-types';

const Database = require('better-sqlite3') as BetterSqliteDatabaseConstructor;

export const PASSENGER_DB_PATH = path.resolve(
  process.cwd(),
  'data/passengers/passengers.sqlite',
);

type BetterSqliteDatabaseConstructor = new (dbPath: string) => BetterSqliteDatabase;

type BetterSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

type PassengerProfileRow = {
  id: number;
  passenger_type: number;
  last_name: string;
  first_name: string;
  normalized_last_name: string;
  normalized_first_name: string;
  normalized_full_name: string;
  title: string;
  gender: number;
  date_of_birth: string | null;
  document_type: string | null;
  document_number: string | null;
  document_expiry_date: string | null;
  document_country: string | null;
  email: string | null;
  source: PassengerProfileInput['source'];
  seen_count: number;
  raw_source_json: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * SQLite-backed local store for passenger profiles, aliases, and confidence.
 *
 * This component owns local persistence only. It does not call 1Booking APIs and
 * does not parse Telegram messages.
 */
export class PassengerStore {
  private readonly db: BetterSqliteDatabase;

  constructor(dbPath = PASSENGER_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), {
      recursive: true,
    });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  /**
   * Creates local passenger cache tables if they do not exist yet.
   */
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passenger_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        passenger_type INTEGER NOT NULL,
        last_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        normalized_last_name TEXT NOT NULL,
        normalized_first_name TEXT NOT NULL,
        normalized_full_name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'UNKNOWN',
        gender INTEGER NOT NULL DEFAULT -1,
        date_of_birth TEXT,
        document_type TEXT,
        document_number TEXT,
        document_expiry_date TEXT,
        document_country TEXT,
        email TEXT,
        source TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        raw_source_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (
          passenger_type,
          normalized_last_name,
          normalized_first_name,
          title,
          gender
        )
      );

      CREATE TABLE IF NOT EXISTS passenger_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        passenger_profile_id INTEGER NOT NULL,
        alias_text TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (passenger_profile_id, normalized_alias, alias_type),
        FOREIGN KEY (passenger_profile_id)
          REFERENCES passenger_profiles(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_passenger_aliases_normalized_alias
        ON passenger_aliases(normalized_alias);

      CREATE TABLE IF NOT EXISTS confidence_score (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        passenger_profile_id INTEGER NOT NULL,
        score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_query TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (passenger_profile_id)
          REFERENCES passenger_profiles(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_confidence_score_profile_created_at
        ON confidence_score(passenger_profile_id, created_at);
    `);

    this.ensurePassengerProfileColumn('email', 'TEXT');
  }

  /**
   * Closes the local SQLite handle.
   */
  close() {
    this.db.close();
  }

  /**
   * Upserts one 1Booking passenger suggestion and its aliases.
   */
  upsertOneBookingSuggestPassenger(item: OneBookingPassengerSuggestItem) {
    return this.upsertPassengerProfile({
      passengerType: item.type,
      lastName: item.lastName,
      firstName: item.firstName,
      title: item.title,
      gender: item.gender,
      source: 'onebooking_suggest',
      rawSourceJson: JSON.stringify(item),
    });
  }

  /**
   * Upserts one passenger profile and refreshes deterministic aliases.
   */
  upsertPassengerProfile(input: PassengerProfileInput) {
    this.migrate();

    const normalizedLastName = normalizePassengerText(input.lastName);
    const normalizedFirstName = normalizePassengerText(input.firstName);
    const normalizedFullName = buildPassengerFullName(
      input.lastName,
      input.firstName,
    );
    const now = new Date().toISOString();
    const title = normalizePassengerTitle(input.title, input.gender);
    const gender = toStoredGender(input.gender);

    const row = this.db
      .prepare(
        `
        INSERT INTO passenger_profiles (
          passenger_type,
          last_name,
          first_name,
          normalized_last_name,
          normalized_first_name,
          normalized_full_name,
          title,
          gender,
          date_of_birth,
          document_type,
          document_number,
          document_expiry_date,
          document_country,
          email,
          source,
          seen_count,
          raw_source_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT (
          passenger_type,
          normalized_last_name,
          normalized_first_name,
          title,
          gender
        )
        DO UPDATE SET
          last_name = excluded.last_name,
          first_name = excluded.first_name,
          date_of_birth = COALESCE(excluded.date_of_birth, passenger_profiles.date_of_birth),
          document_type = COALESCE(excluded.document_type, passenger_profiles.document_type),
          document_number = COALESCE(excluded.document_number, passenger_profiles.document_number),
          document_expiry_date = COALESCE(excluded.document_expiry_date, passenger_profiles.document_expiry_date),
          document_country = COALESCE(excluded.document_country, passenger_profiles.document_country),
          email = COALESCE(excluded.email, passenger_profiles.email),
          source = excluded.source,
          seen_count = passenger_profiles.seen_count + 1,
          raw_source_json = excluded.raw_source_json,
          updated_at = excluded.updated_at
        RETURNING *;
      `,
      )
      .get(
        input.passengerType,
        input.lastName.trim().toUpperCase(),
        input.firstName.trim().toUpperCase(),
        normalizedLastName,
        normalizedFirstName,
        normalizedFullName,
        title,
        gender,
        input.dateOfBirth ?? null,
        input.documentType ?? null,
        input.documentNumber ?? null,
        input.documentExpiryDate ?? null,
        input.documentCountry ?? null,
        input.email ?? null,
        input.source,
        input.rawSourceJson ?? null,
        now,
        now,
      ) as PassengerProfileRow;

    const profile = mapPassengerProfileRow(row);
    this.upsertPassengerAliases(
      generatePassengerAliases({
        passengerProfileId: profile.id,
        lastName: profile.lastName,
        firstName: profile.firstName,
      }),
    );

    return profile;
  }

  /**
   * Inserts aliases for passenger lookup while preserving existing rows.
   */
  upsertPassengerAliases(aliases: PassengerAliasInput[]) {
    this.migrate();
    const now = new Date().toISOString();
    const insertAlias = this.db.prepare(`
      INSERT INTO passenger_aliases (
        passenger_profile_id,
        alias_text,
        normalized_alias,
        alias_type,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (passenger_profile_id, normalized_alias, alias_type)
      DO NOTHING;
    `);

    for (const alias of aliases) {
      insertAlias.run(
        alias.passengerProfileId,
        alias.aliasText,
        alias.normalizedAlias,
        alias.aliasType,
        now,
      );
    }
  }

  /**
   * Finds profiles by a normalized alias such as `LANH`.
   */
  findProfilesByAlias(rawAlias: string) {
    this.migrate();
    const normalizedAlias = normalizePassengerText(rawAlias);
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT passenger_profiles.*
        FROM passenger_profiles
        INNER JOIN passenger_aliases
          ON passenger_aliases.passenger_profile_id = passenger_profiles.id
        WHERE passenger_aliases.normalized_alias = ?
        ORDER BY passenger_profiles.seen_count DESC, passenger_profiles.updated_at DESC;
      `,
      )
      .all(normalizedAlias) as PassengerProfileRow[];

    return rows.map(mapPassengerProfileRow);
  }

  /**
   * Finds profiles whose canonical normalized full name matches exactly.
   */
  findProfilesByNormalizedFullName(rawFullName: string) {
    this.migrate();
    const normalizedFullName = normalizePassengerText(rawFullName);
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM passenger_profiles
        WHERE normalized_full_name = ?
        ORDER BY seen_count DESC, updated_at DESC;
      `,
      )
      .all(normalizedFullName) as PassengerProfileRow[];

    return rows.map(mapPassengerProfileRow);
  }

  /**
   * Returns cached passenger profiles for local scoring.
   *
   * The local MVP cache is intentionally small enough to score in process.
   */
  listPassengerProfiles(limit = 5000) {
    this.migrate();
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM passenger_profiles
        ORDER BY seen_count DESC, updated_at DESC
        LIMIT ?;
      `,
      )
      .all(limit) as PassengerProfileRow[];

    return rows.map(mapPassengerProfileRow);
  }

  /**
   * Reads one cached passenger profile by local id.
   */
  getPassengerProfileById(profileId: number) {
    this.migrate();
    const row = this.db
      .prepare('SELECT * FROM passenger_profiles WHERE id = ?;')
      .get(profileId) as PassengerProfileRow | undefined;

    return row ? mapPassengerProfileRow(row) : null;
  }

  /**
   * Persists resolver confidence evidence for audit and future tuning.
   */
  insertConfidenceScore(input: ConfidenceScoreInput) {
    this.migrate();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO confidence_score (
          passenger_profile_id,
          score,
          reason,
          source,
          observed_query,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.passengerProfileId,
        input.score,
        input.reason,
        input.source,
        input.observedQuery,
        now,
      );
  }

  /**
   * Returns lightweight local DB stats for bootstrap verification.
   */
  getStats() {
    this.migrate();
    const profileCount = getCount(this.db, 'passenger_profiles');
    const aliasCount = getCount(this.db, 'passenger_aliases');
    const confidenceScoreCount = getCount(this.db, 'confidence_score');

    return {
      profileCount,
      aliasCount,
      confidenceScoreCount,
    };
  }

  /**
   * Builds incremental seed keywords from cached given-name aliases.
   */
  listIncrementalSeedKeywords(limit = 50) {
    this.migrate();
    const rows = this.db
      .prepare(
        `
        SELECT normalized_alias
        FROM passenger_aliases
        WHERE alias_type = 'given_name'
        GROUP BY normalized_alias
        ORDER BY COUNT(*) DESC, normalized_alias ASC
        LIMIT ?;
      `,
      )
      .all(limit) as Array<{ normalized_alias: string }>;

    return rows.map((row) => row.normalized_alias);
  }

  /**
   * Adds a nullable column when an existing local DB predates a schema field.
   *
   * SQLite CREATE TABLE IF NOT EXISTS does not evolve existing tables, so the
   * lean local store applies small additive migrations explicitly.
   */
  private ensurePassengerProfileColumn(columnName: string, sqlType: string) {
    const columns = this.db
      .prepare('PRAGMA table_info(passenger_profiles);')
      .all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(
        `ALTER TABLE passenger_profiles ADD COLUMN ${columnName} ${sqlType};`,
      );
    }
  }
}

function mapPassengerProfileRow(row: PassengerProfileRow): PassengerProfile {
  return {
    id: row.id,
    passengerType: row.passenger_type,
    lastName: row.last_name,
    firstName: row.first_name,
    normalizedLastName: row.normalized_last_name,
    normalizedFirstName: row.normalized_first_name,
    normalizedFullName: row.normalized_full_name,
    title: row.title,
    gender: fromStoredGender(row.gender),
    dateOfBirth: row.date_of_birth,
    documentType: row.document_type,
    documentNumber: row.document_number,
    documentExpiryDate: row.document_expiry_date,
    documentCountry: row.document_country,
    email: row.email,
    source: row.source,
    seenCount: row.seen_count,
    rawSourceJson: row.raw_source_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredGender(gender: boolean | null) {
  if (gender === true) return 1;
  if (gender === false) return 0;

  return -1;
}

/**
 * Normalizes passenger title to the 1Booking-supported title set.
 *
 * Current 1Booking passenger suggest data uses `MR` for male and `MS` for
 * female. Treat `MRS` as `MS` so duplicate detection and form mapping remain
 * consistent with the upstream source.
 */
function normalizePassengerTitle(title: string, gender: boolean | null) {
  const normalizedTitle = title.trim().toUpperCase();

  if (normalizedTitle === 'MRS') {
    return 'MS';
  }

  if (normalizedTitle === 'MR' || normalizedTitle === 'MS') {
    return normalizedTitle;
  }

  if (gender === true) {
    return 'MR';
  }

  if (gender === false) {
    return 'MS';
  }

  return normalizedTitle || 'UNKNOWN';
}

function fromStoredGender(gender: number) {
  if (gender === 1) return true;
  if (gender === 0) return false;

  return null;
}

function getCount(db: BetterSqliteDatabase, tableName: string) {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName};`)
    .get() as { count: number };

  return row.count;
}
