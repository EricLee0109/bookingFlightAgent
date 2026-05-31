import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OneBookingPassengerSuggestAdapter } from '../src/passengers/onebooking-passenger-suggest-adapter';
import { readOneBookingAccessToken } from '../src/passengers/onebooking-auth-token';
import { generatePassengerAliases } from '../src/passengers/passenger-alias-generator';
import { PassengerResolver } from '../src/passengers/passenger-resolver';
import { PassengerStore } from '../src/passengers/passenger-store';

const TEST_DIR = path.resolve(process.cwd(), 'data/passengers/__tests__');
const TEST_DB_PATH = path.join(TEST_DIR, 'passengers.sqlite');
const TEST_AUTH_PATH = path.join(TEST_DIR, '1booking-storage-state.json');

/**
 * Prepares isolated local files for passenger cache contract tests.
 */
function prepareTestFiles() {
  fs.rmSync(TEST_DIR, {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(TEST_DIR, {
    recursive: true,
  });
}

/**
 * Writes a minimal Playwright storage state containing a fake access token.
 */
function writeTestAuthState(accessToken = 'secret-access-token') {
  fs.writeFileSync(
    TEST_AUTH_PATH,
    `${JSON.stringify(
      {
        origins: [
          {
            origin: 'https://pro.1booking.vn',
            localStorage: [
              {
                name: 'authentication',
                value: JSON.stringify({
                  state: {
                    accessToken,
                  },
                }),
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Verifies that access token extraction reads the saved auth state.
 */
async function testAccessTokenExtraction() {
  writeTestAuthState();

  assert.equal(
    await readOneBookingAccessToken(TEST_AUTH_PATH),
    'secret-access-token',
  );

  await assert.rejects(
    () => readOneBookingAccessToken(path.join(TEST_DIR, 'missing.json')),
    (error) =>
      error instanceof Error &&
      /save-auth:dev/.test(error.message) &&
      !/secret-access-token/.test(error.message),
  );
}

/**
 * Verifies adapter payload and Authorization header without hitting network.
 */
async function testSuggestAdapterPayload() {
  writeTestAuthState('adapter-token');
  let capturedBody = '';
  let capturedAuthorization = '';
  const adapter = new OneBookingPassengerSuggestAdapter({
    storageStatePath: TEST_AUTH_PATH,
    async fetchImpl(_input, init) {
      capturedBody = init.body;
      capturedAuthorization = init.headers.Authorization;

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([
            {
              type: 0,
              lastName: 'NGUYEN',
              firstName: 'THI LANH',
              title: 'MS',
              gender: false,
            },
          ]);
        },
      };
    },
  });

  const passengers = await adapter.suggestPassengers('Nguyen', 0);

  assert.equal(capturedAuthorization, 'Bearer adapter-token');
  assert.deepEqual(JSON.parse(capturedBody), {
    keyword: 'Nguyen',
    type: 0,
  });
  assert.equal(passengers[0].lastName, 'NGUYEN');
  assert.equal(passengers[0].firstName, 'THI LANH');
}

/**
 * Verifies alias generation for Vietnamese-style passenger names.
 */
function testAliasGenerator() {
  const aliases = generatePassengerAliases({
    passengerProfileId: 1,
    lastName: 'NGUYEN',
    firstName: 'THI LANH',
  }).map((alias) => alias.normalizedAlias);

  assert.ok(aliases.includes('NGUYEN THI LANH'));
  assert.ok(aliases.includes('THI LANH'));
  assert.ok(aliases.includes('LANH'));
}

/**
 * Verifies SQLite schema, profile upsert, aliases, and confidence_score writes.
 */
function testPassengerStoreAndResolver() {
  const store = new PassengerStore(TEST_DB_PATH);

  try {
    store.migrate();
    assert.deepEqual(store.getStats(), {
      profileCount: 0,
      aliasCount: 0,
      confidenceScoreCount: 0,
    });

    const firstProfile = store.upsertOneBookingSuggestPassenger({
      type: 0,
      lastName: 'NGUYEN',
      firstName: 'THI LANH',
      title: 'MS',
      gender: false,
    });
    const duplicateProfile = store.upsertOneBookingSuggestPassenger({
      type: 0,
      lastName: 'NGUYEN',
      firstName: 'THI LANH',
      title: 'MRS',
      gender: false,
    });

    assert.equal(firstProfile.id, duplicateProfile.id);
    assert.equal(firstProfile.title, 'MS');
    assert.equal(duplicateProfile.title, 'MS');
    assert.equal(duplicateProfile.seenCount, 2);
    assert.equal(store.getStats().profileCount, 1);
    assert.ok(store.getStats().aliasCount >= 3);

    const resolver = new PassengerResolver(store);
    const exactResult = resolver.resolve('chi Lanh');

    assert.equal(exactResult.status, 'matched_but_missing_fields');

    if (exactResult.status === 'matched_but_missing_fields') {
      assert.equal(exactResult.profile.normalizedFullName, 'NGUYEN THI LANH');
      assert.equal(exactResult.reason, 'missing_required_field');
      assert.deepEqual(exactResult.missingFields, [
        'dob',
        'idType',
        'idNumber',
        'idExpiry',
      ]);
    }

    assert.equal(store.getStats().confidenceScoreCount, 1);

    store.upsertOneBookingSuggestPassenger({
      type: 0,
      lastName: 'TRAN',
      firstName: 'THI LANH',
      title: 'MS',
      gender: false,
    });

    const ambiguousResult = resolver.resolve('Lanh');

    assert.equal(ambiguousResult.status, 'ambiguous');
    assert.equal(ambiguousResult.reason, 'ambiguous_candidate');
    assert.equal(
      ambiguousResult.status === 'ambiguous'
        ? ambiguousResult.candidates.length
        : 0,
      2,
    );
    assert.equal(store.getStats().confidenceScoreCount, 3);
  } finally {
    store.close();
  }
}

async function main() {
  prepareTestFiles();
  await testAccessTokenExtraction();
  await testSuggestAdapterPayload();
  testAliasGenerator();
  testPassengerStoreAndResolver();

  console.log('Passenger cache contract tests passed.');
}

main().catch((error) => {
  console.error('Passenger cache contract tests failed:', error);
  process.exit(1);
});
