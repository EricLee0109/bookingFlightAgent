import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CustomerPassengerStore, CustomerPassengerOwnerMismatchError, CustomerPassengerVersionConflictError } from '../src/passengers/customer-passenger-store';
import type { CustomerPassengerInfo } from '../src/passengers/customer-passenger-types';

const Database = require('better-sqlite3') as new (dbPath: string) => {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
};

const VALID_INFO: CustomerPassengerInfo = {
  lastName: 'NGUYEN',
  firstName: 'THI LANH',
  gender: 'F',
  dob: '1990-02-28',
};

function createTempDbPath() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'booking-flight-customer-passenger-'),
  );

  return {
    directory,
    dbPath: path.join(directory, 'passengers.sqlite'),
  };
}

function seedLegacyProfile(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE passenger_profiles (
      id INTEGER PRIMARY KEY,
      last_name TEXT NOT NULL,
      first_name TEXT NOT NULL
    );
    INSERT INTO passenger_profiles (id, last_name, first_name)
    VALUES (17, 'LEGACY', 'PASSENGER');
  `);
  const rows = db.prepare('SELECT * FROM passenger_profiles;').all();
  db.close();
  return rows;
}

function readLegacyProfiles(dbPath: string) {
  const db = new Database(dbPath);
  const rows = db.prepare('SELECT * FROM passenger_profiles;').all();
  db.close();
  return rows;
}

function testMigrationDoesNotTouchLegacyTables(dbPath: string) {
  const before = seedLegacyProfile(dbPath);
  const store = new CustomerPassengerStore(dbPath);

  try {
    store.migrate();
    store.migrate();

    const db = new Database(dbPath);
    const customerTableCount = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'customer_passenger_profiles';
      `,
      )
      .get() as { count: number };
    db.close();

    assert.equal(customerTableCount.count, 1);
    assert.deepEqual(readLegacyProfiles(dbPath), before);
  } finally {
    store.close();
  }
}

function testCreateAndOwnerIsolation(dbPath: string) {
  const store = new CustomerPassengerStore(dbPath);

  try {
    const first = store.create(101, VALID_INFO, 'create-1');
    assert.equal(first.version, 1);
    assert.equal(first.ownerTelegramUserId, 101);

    const idempotent = store.create(
      101,
      { ...VALID_INFO, dob: '1991-03-01' },
      'create-1',
    );
    assert.equal(idempotent.id, first.id);
    assert.equal(idempotent.dob, VALID_INFO.dob);
    assert.equal(idempotent.version, first.version);

    const sameNameDifferentDob = store.create(
      101,
      { ...VALID_INFO, dob: '1991-03-01' },
      'create-2',
    );
    assert.notEqual(sameNameDifferentDob.id, first.id);
    assert.equal(store.list(101).total, 2);

    assert.equal(store.get(202, first.id), null);
    assert.equal(store.list(202).total, 0);
    assert.throws(
      () => store.update(202, first.id, 1, VALID_INFO),
      CustomerPassengerOwnerMismatchError,
    );
    assert.equal(store.get(101, first.id)?.dob, VALID_INFO.dob);
  } finally {
    store.close();
  }
}

function testUpdateAndVersionConflict(dbPath: string) {
  const store = new CustomerPassengerStore(dbPath);

  try {
    const created = store.create(303, VALID_INFO, 'update-1');
    const updated = store.update(303, created.id, created.version, {
      ...VALID_INFO,
      firstName: 'THI MAI',
      dob: '1992-04-03',
    });

    assert.equal(updated.version, 2);
    assert.equal(updated.firstName, 'THI MAI');
    assert.equal(updated.dob, '1992-04-03');
    assert.throws(
      () =>
        store.update(303, created.id, created.version, {
          ...VALID_INFO,
          firstName: 'STALE UPDATE',
        }),
      CustomerPassengerVersionConflictError,
    );
    assert.equal(store.get(303, created.id)?.firstName, 'THI MAI');
  } finally {
    store.close();
  }
}

function testValidationNormalizationAndPagination(dbPath: string) {
  const store = new CustomerPassengerStore(dbPath);

  try {
    const accented = store.create(
      404,
      {
        lastName: ' Nguyễn ',
        firstName: 'Thị   Lãnh',
        gender: 'F',
        dob: '1990-02-28',
      },
      'accented',
    );
    assert.equal(accented.lastName, 'Nguyễn');
    assert.equal(
      store.list(404, { query: 'nguyen thi' }).profiles[0]?.id,
      accented.id,
    );
    assert.equal(store.list(404, { query: '%' }).total, 0);

    for (let index = 0; index < 7; index += 1) {
      store.create(
        505,
        {
          lastName: `Family ${index}`,
          firstName: 'Passenger',
          gender: index % 2 === 0 ? 'M' : 'F',
          dob: `198${index}-01-0${index + 1}`,
        },
        `page-${index}`,
      );
    }

    const firstPage = store.list(505);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.total, 7);
    assert.equal(firstPage.profiles.length, 5);
    assert.equal(store.list(505, { page: 2 }).profiles.length, 2);
    assert.deepEqual(store.list(505, { page: 3 }).profiles, []);
    assert.equal(store.list(505, { page: 3 }).total, 7);
    assert.equal(store.list(505, { pageSize: 99 }).profiles.length, 5);

    assert.throws(() => store.list(505, { page: 0 }), /page/);
    assert.throws(() => store.list(505, { page: 1.5 }), /page/);
    assert.throws(() => store.list(505, { pageSize: 0 }), /pageSize/);
    assert.throws(() => store.list(505, { query: 7 as unknown as string }), /query/);

    assert.throws(() => store.create(0, VALID_INFO, 'invalid-owner'), /owner/);
    assert.throws(() => store.create(1, { ...VALID_INFO, lastName: '   ' }, 'invalid-name'), /lastName/);
    assert.throws(() => store.create(1, { ...VALID_INFO, gender: 'X' as 'M' }, 'invalid-gender'), /gender/);
    for (const dob of ['1990-02-29', '1990-2-09', '1990-01-01T00:00:00Z', '0000-01-01']) {
      assert.throws(() => store.create(1, { ...VALID_INFO, dob }, `invalid-dob-${dob}`), /dob/);
    }
  } finally {
    store.close();
  }
}

function main() {
  const { directory, dbPath } = createTempDbPath();

  try {
    testMigrationDoesNotTouchLegacyTables(dbPath);
    testCreateAndOwnerIsolation(dbPath);
    testUpdateAndVersionConflict(dbPath);
    testValidationNormalizationAndPagination(dbPath);
    console.log('Customer passenger store tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error('Customer passenger store tests failed:', error);
  process.exitCode = 1;
}
