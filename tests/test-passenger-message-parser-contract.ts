import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOpenAIPassengerMessageParser } from '../src/agent/openai-passenger-message-parser';
import { parseFlightSelectionMessage } from '../src/agent/flight-selection-parser';
import {
  ParsedPassengerMessageSchema,
  type ParsedPassengerMessage,
} from '../src/contracts/passenger';
import { PassengerResolver } from '../src/passengers/passenger-resolver';
import { PassengerStore } from '../src/passengers/passenger-store';
import { PassengerResolutionService } from '../src/services/passenger-resolution-service';
import {
  getTelegramPassengerContext,
  setActivePassengerCase,
  setPendingPassengerProfiles,
} from '../src/telegram/telegram-passenger-context';
import {
  buildPassengerCandidateKeyboard,
  parsePassengerCallbackData,
} from '../src/telegram/telegram-passenger-keyboards';

const TEST_DIR = path.resolve(
  process.cwd(),
  'data/passengers/__tests__/passenger-parser',
);
const TEST_DB_PATH = path.join(TEST_DIR, 'passengers.sqlite');

const parsedPassengerMessage: ParsedPassengerMessage = {
  intent: 'attach_passenger',
  caseCode: 'BK-20260525-162456',
  passengerMentions: [
    {
      rawMention: 'chị Lanh',
      displayName: 'Lanh',
      fullName: null,
      honorific: 'chị',
      genderHint: 'female',
      passengerTypeHint: 'adult',
      dob: null,
      age: null,
      idType: null,
      idNumber: null,
      idExpiry: null,
      rawQuickInput: null,
    },
  ],
  missingFields: [],
  confidence: 0.94,
};

/**
 * Prepares isolated local files for passenger parser contract tests.
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
 * Verifies the strict structured passenger parser schema.
 */
function testPassengerMessageSchema() {
  assert.equal(
    ParsedPassengerMessageSchema.parse(parsedPassengerMessage).intent,
    'attach_passenger',
  );
  assert.throws(() =>
    ParsedPassengerMessageSchema.parse({
      ...parsedPassengerMessage,
      unexpectedField: 'not allowed',
    }),
  );
}

/**
 * Verifies OpenAI parser integration using a fake structured-output client.
 */
async function testOpenAIPassengerMessageParser() {
  const parser = createOpenAIPassengerMessageParser({
    client: {
      chat: {
        completions: {
          async parse() {
            return {
              choices: [
                {
                  message: {
                    parsed: parsedPassengerMessage,
                  },
                },
              ],
            };
          },
        },
      },
    },
  });

  assert.deepEqual(
    await parser.parse('case BK-20260525-162456 lấy chị Lanh'),
    parsedPassengerMessage,
  );
}

/**
 * Verifies resolver states for ambiguous, exact, and unknown names.
 */
function testPassengerResolverStates() {
  const store = new PassengerStore(TEST_DB_PATH);

  try {
    const nguyenLanh = store.upsertPassengerProfile({
      passengerType: 0,
      lastName: 'NGUYEN',
      firstName: 'THI LANH',
      title: 'MS',
      gender: false,
      source: 'onebooking_suggest',
    });
    store.upsertPassengerProfile({
      passengerType: 0,
      lastName: 'TRAN',
      firstName: 'THI LANH',
      title: 'MS',
      gender: false,
      source: 'onebooking_suggest',
    });
    const resolver = new PassengerResolver(store);

    assert.equal(resolver.resolve('Lanh').status, 'ambiguous');
    assert.equal(
      resolver.resolve('Nguyễn Thị Lành').status,
      'matched_but_missing_fields',
    );
    assert.equal(resolver.resolve('Ten Khong Ton Tai').status, 'not_found');

    const keyboard = buildPassengerCandidateKeyboard('BK-20260525-162456', [
      nguyenLanh,
    ]);
    const callbackData = keyboard.inline_keyboard[0][0].callback_data;

    assert.deepEqual(parsePassengerCallbackData(callbackData), {
      action: 'choose',
      caseId: 'BK-20260525-162456',
      passengerProfileId: nguyenLanh.id,
    });
  } finally {
    store.close();
  }
}

/**
 * Verifies that quick operator details enrich a matched local profile and make
 * it ready for later form fill without starting Playwright.
 */
function testPassengerProfileEnrichment() {
  const store = new PassengerStore(TEST_DB_PATH);

  try {
    const service = new PassengerResolutionService(store);
    const result = service.resolveMention({
      rawMention: 'Nguyễn Thị Lành sinh 14/02/1990 CCCD 012345678901',
      displayName: 'Nguyễn Thị Lành',
      fullName: 'Nguyễn Thị Lành',
      honorific: 'chị',
      genderHint: 'female',
      passengerTypeHint: 'adult',
      dob: '1990-02-14',
      age: null,
      idType: 'cccd',
      idNumber: '012345678901',
      idExpiry: '2030-02-14',
      rawQuickInput:
        'Nguyễn Thị Lành sinh 14/02/1990 CCCD 012345678901 hết hạn 14/02/2030',
    });

    assert.equal(result.status, 'matched');

    if (result.status === 'matched') {
      assert.equal(result.profile.dateOfBirth, '1990-02-14');
      assert.equal(result.profile.documentType, 'cccd');
      assert.equal(result.profile.documentNumber, '012345678901');
      assert.equal(result.profile.documentExpiryDate, '2030-02-14');
    }
  } finally {
    store.close();
  }
}

/**
 * Verifies Phase D manual upsert, alias generation, duplicate prevention,
 * PassengerInfo mapping, and case_passengers attachment.
 */
function testNewPassengerUpsertAndCaseAttachment() {
  const store = new PassengerStore(TEST_DB_PATH);

  try {
    const service = new PassengerResolutionService(store);
    const completeMention = {
      rawMention: 'chị Phát',
      displayName: 'Nguyễn Thị Phát',
      fullName: 'Nguyễn Thị Phát',
      honorific: 'chị',
      genderHint: 'female' as const,
      passengerTypeHint: 'adult' as const,
      dob: '1992-03-15',
      age: null,
      idType: 'cccd' as const,
      idNumber: '079092001234',
      idExpiry: '2032-03-15',
      rawQuickInput:
        'Nguyễn Thị Phát sinh 15/03/1992 CCCD 079092001234 hết hạn 15/03/2032',
    };
    const firstResult = service.resolveMention(completeMention, {
      caseId: 'BK-20260525-162456',
    });

    assert.equal(firstResult.status, 'passenger_ready');

    if (firstResult.status !== 'passenger_ready') {
      throw new Error('Expected a passenger_ready manual upsert result.');
    }

    assert.equal(firstResult.passengerInfo.lastName, 'NGUYỄN');
    assert.equal(firstResult.passengerInfo.firstName, 'THỊ PHÁT');
    assert.equal(firstResult.passengerInfo.gender, 'F');
    assert.equal(firstResult.casePassenger.status, 'passenger_ready');
    assert.equal(
      store.getCasePassenger('BK-20260525-162456')?.passengerProfileId,
      firstResult.profile.id,
    );
    assert.equal(store.findProfilesByAlias('chị Phát').length, 1);

    const profileCountBeforeDuplicate = store.getStats().profileCount;
    const duplicateResult = service.upsertNewPassenger(
      completeMention,
      'BK-20260525-162456',
    );

    assert.equal(duplicateResult.status, 'passenger_ready');

    if (duplicateResult.status === 'passenger_ready') {
      assert.equal(duplicateResult.profile.id, firstResult.profile.id);
    }

    assert.equal(store.getStats().profileCount, profileCountBeforeDuplicate);
  } finally {
    store.close();
  }
}

/**
 * Verifies incomplete manual input asks only for missing fields and is not
 * inserted into SQLite.
 */
function testIncompleteNewPassengerIsNotInserted() {
  const store = new PassengerStore(TEST_DB_PATH);

  try {
    const service = new PassengerResolutionService(store);
    const profileCountBefore = store.getStats().profileCount;
    const result = service.resolveMention(
      {
        rawMention: 'Trần Văn Mới',
        displayName: 'Trần Văn Mới',
        fullName: 'Trần Văn Mới',
        honorific: 'anh',
        genderHint: 'male',
        passengerTypeHint: 'adult',
        dob: null,
        age: null,
        idType: null,
        idNumber: null,
        idExpiry: null,
        rawQuickInput: null,
      },
      {
        caseId: 'BK-20260525-162456',
      },
    );

    assert.equal(result.status, 'new_passenger_missing_fields');

    if (result.status === 'new_passenger_missing_fields') {
      assert.deepEqual(result.missingFields, ['dob', 'idNumber', 'idExpiry']);
    }

    assert.equal(store.getStats().profileCount, profileCountBefore);

    const nicknameOnlyResult = service.resolveMention(
      {
        rawMention: 'chị Khách Mới',
        displayName: 'Khách Mới',
        fullName: null,
        honorific: 'chị',
        genderHint: 'female',
        passengerTypeHint: 'adult',
        dob: null,
        age: null,
        idType: null,
        idNumber: null,
        idExpiry: null,
        rawQuickInput: null,
      },
      {
        caseId: 'BK-20260525-162456',
      },
    );

    assert.equal(nicknameOnlyResult.status, 'new_passenger_missing_fields');

    if (nicknameOnlyResult.status === 'new_passenger_missing_fields') {
      assert.deepEqual(nicknameOnlyResult.missingFields, [
        'fullName',
        'dob',
        'idNumber',
        'idExpiry',
      ]);
    }

    assert.equal(store.getStats().profileCount, profileCountBefore);
  } finally {
    store.close();
  }
}

/**
 * Verifies passenger context and prevents passenger messages from being claimed
 * by the flight-selection parser merely because they include a case code.
 */
function testTelegramPassengerContextAndRouting() {
  setActivePassengerCase(123, 'BK-20260525-162456');
  setPendingPassengerProfiles(123, 'BK-20260525-162456', [7]);

  assert.deepEqual(getTelegramPassengerContext(123), {
    activeCaseId: 'BK-20260525-162456',
    pendingPassengerProfileIds: [7],
  });
  assert.deepEqual(
    parseFlightSelectionMessage('case BK-20260525-162456 lấy chị Lanh'),
    {
      isSelectionMessage: false,
    },
  );
}

async function main() {
  prepareTestFiles();
  testPassengerMessageSchema();
  await testOpenAIPassengerMessageParser();
  testPassengerResolverStates();
  testPassengerProfileEnrichment();
  testNewPassengerUpsertAndCaseAttachment();
  testIncompleteNewPassengerIsNotInserted();
  testTelegramPassengerContextAndRouting();

  console.log('Passenger message parser contract tests passed.');
}

main().catch((error) => {
  console.error('Passenger message parser contract tests failed:', error);
  process.exit(1);
});
