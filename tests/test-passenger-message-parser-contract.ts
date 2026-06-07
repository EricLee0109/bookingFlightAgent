import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPassengerParserSystemPrompt,
  createOpenAIPassengerMessageParser,
} from '../src/agent/openai-passenger-message-parser';
import { parseFlightSelectionMessage } from '../src/agent/flight-selection-parser';
import {
  assertSafeFinalHoldCtaText,
  buildPassengerQuickInput,
  isDurableHeldOrderTerminalState,
  PostSubmitHoldError,
} from '../src/automation/1booking/hold-booking';
import { OneBookingAuthExpiredError } from '../src/automation/1booking/waiters';
import {
  buildExactFlightNumberPattern,
  extractPnrCodesFromHeldOrderText,
  isValidPnrCode,
} from '../src/automation/1booking/pnr';
import {
  ParsedPassengerMessageSchema,
  type ParsedPassengerMessage,
} from '../src/contracts/passenger';
import { PassengerResolver } from '../src/passengers/passenger-resolver';
import { PassengerStore } from '../src/passengers/passenger-store';
import { PassengerResolutionService } from '../src/services/passenger-resolution-service';
import {
  getHoldAutomationFailureStatus,
  getMissingHoldPassengerFields,
  getPnrExtractionStatus,
} from '../src/services/passenger-hold-automation-service';
import {
  recoverHeldBookingCase,
  validateRecoverableHoldCase,
} from '../src/services/passenger-hold-recovery-service';
import { OneBookingAuthRefreshRetryController } from '../src/services/onebooking-auth-refresh-retry';
import {
  getTelegramPassengerContext,
  setActivePassengerCase,
  setPendingPassengerProfiles,
} from '../src/telegram/telegram-passenger-context';
import {
  buildPassengerCandidateKeyboard,
  parsePassengerCallbackData,
} from '../src/telegram/telegram-passenger-keyboards';
import {
  formatNewPassengerMissingFieldsMessage,
  formatPassengerHoldNeedsReviewMessage,
  formatPassengerHoldSuccessMessage,
  formatPassengerMissingFieldsMessage,
} from '../src/telegram/telegram-formatters';
import { parseHoldRecoveryMessage } from '../src/telegram/telegram-hold-recovery';
import {
  mergePassengerMentions,
  messageLooksLikePassengerInfo,
} from '../src/telegram/telegram-passenger-message-handler';
import { hasReadyPassengerForCombinedHold } from '../src/telegram/telegram-message-handler';
import { type LocalFlightCase } from '../src/storage/local-case-store';

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
      fullName: 'Lanh',
      gender: 'female',
      dob: null,
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
 * Verifies the passenger parser contract supports short follow-up and quick
 * input messages without adding non-MVP contact/document fields.
 */
function testPassengerQuickInputParserContract() {
  const genderOnly = ParsedPassengerMessageSchema.parse({
    intent: 'update_passenger_fields',
    caseCode: null,
    passengerMentions: [
      {
        fullName: null,
        gender: 'female',
        dob: null,
      },
    ],
    missingFields: [],
    confidence: 0.9,
  });
  const quickInput = ParsedPassengerMessageSchema.parse({
    intent: 'provide_new_passenger',
    caseCode: null,
    passengerMentions: [
      {
        fullName: 'Nguyễn Thị Oanh',
        gender: 'female',
        dob: null,
      },
    ],
    missingFields: [],
    confidence: 0.94,
  });
  const dobInput = ParsedPassengerMessageSchema.parse({
    intent: 'update_passenger_fields',
    caseCode: null,
    passengerMentions: [
      {
        fullName: 'Nguyễn Thị Oanh',
        gender: null,
        dob: '1995-01-02',
      },
    ],
    missingFields: [],
    confidence: 0.92,
  });
  const prompt = buildPassengerParserSystemPrompt();

  assert.equal(genderOnly.passengerMentions[0].gender, 'female');
  assert.equal(quickInput.passengerMentions[0].fullName, 'Nguyễn Thị Oanh');
  assert.equal(dobInput.passengerMentions[0].dob, '1995-01-02');
  assert.match(prompt, /standalone "Nam"/);
  assert.match(prompt, /Nữ, Nguyễn Thị Oanh/);
  assert.doesNotMatch(prompt, /phone|email|passport|cccd|document/i);
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
      'matched',
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
 * Verifies that an optional DOB enriches a matched local profile.
 */
function testPassengerProfileEnrichment() {
  const store = new PassengerStore(TEST_DB_PATH);

  try {
    const service = new PassengerResolutionService(store);
    const result = service.resolveMention({
      fullName: 'Nguyễn Thị Lành',
      gender: 'female',
      dob: '1990-02-14',
    });

    assert.equal(result.status, 'matched');

    if (result.status === 'matched') {
      assert.equal(result.profile.dateOfBirth, '1990-02-14');
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
      fullName: 'Nguyễn Thị Phát',
      gender: 'female' as const,
      dob: null,
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
    assert.equal(firstResult.passengerInfo.dob, null);
    assert.equal(firstResult.casePassenger.status, 'passenger_ready');
    assert.equal(
      store.getCasePassenger('BK-20260525-162456')?.passengerProfileId,
      firstResult.profile.id,
    );
    assert.equal(
      store.markCasePassengerSuccessfulHold('BK-20260525-162456').status,
      'successful_hold',
    );
    assert.equal(
      store.getCasePassenger('BK-20260525-162456')?.status,
      'successful_hold',
    );
    assert.equal(store.findProfilesByAlias('Phát').length, 1);

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
        fullName: 'Trần Văn Mới',
        gender: null,
        dob: null,
      },
      {
        caseId: 'BK-20260525-162456',
      },
    );

    assert.equal(result.status, 'new_passenger_missing_fields');

    if (result.status === 'new_passenger_missing_fields') {
      assert.deepEqual(result.missingFields, ['gender']);
    }

    assert.equal(store.getStats().profileCount, profileCountBefore);

    const nicknameOnlyResult = service.resolveMention(
      {
        fullName: null,
        gender: 'female',
        dob: null,
      },
      {
        caseId: 'BK-20260525-162456',
      },
    );

    assert.equal(nicknameOnlyResult.status, 'new_passenger_missing_fields');

    if (nicknameOnlyResult.status === 'new_passenger_missing_fields') {
      assert.deepEqual(nicknameOnlyResult.missingFields, ['fullName']);
    }

    assert.equal(store.getStats().profileCount, profileCountBefore);
  } finally {
    store.close();
  }
}

/**
 * Verifies Telegram follow-up replies enrich the previous passenger draft.
 */
function testPassengerDraftMergeForSplitInputs() {
  assert.deepEqual(
    mergePassengerMentions(
      {
        fullName: 'Nguyễn Thị Oanh',
        gender: null,
        dob: null,
      },
      {
        fullName: null,
        gender: 'female',
        dob: null,
      },
    ),
    {
      fullName: 'Nguyễn Thị Oanh',
      gender: 'female',
      dob: null,
    },
  );
  assert.deepEqual(
    mergePassengerMentions(
      {
        fullName: null,
        gender: 'female',
        dob: null,
      },
      {
        fullName: 'Nguyễn Thị Oanh',
        gender: null,
        dob: null,
      },
    ),
    {
      fullName: 'Nguyễn Thị Oanh',
      gender: 'female',
      dob: null,
    },
  );
  assert.deepEqual(
    mergePassengerMentions(
      {
        fullName: 'Nguyễn Thị Oanh',
        gender: null,
        dob: null,
      },
      {
        fullName: 'Oanh',
        gender: 'female',
        dob: null,
      },
    ),
    {
      fullName: 'Nguyễn Thị Oanh',
      gender: 'female',
      dob: null,
    },
  );
}

/**
 * Verifies missing-field Telegram messages use natural copy-ready examples
 * instead of leaking internal schema field names.
 */
function testPassengerMissingFieldTelegramMessages() {
  const genericMessage = formatNewPassengerMissingFieldsMessage([
    'fullName',
    'gender',
  ]);
  const nameKnownMessage = formatNewPassengerMissingFieldsMessage(
    ['gender'],
    {
      fullName: 'Nguyễn Thị Oanh',
      gender: null,
      dob: null,
    },
  );
  const genderKnownMessage = formatNewPassengerMissingFieldsMessage(
    ['fullName'],
    {
      fullName: null,
      gender: 'female',
      dob: null,
    },
  );
  const storedProfileMessage = formatPassengerMissingFieldsMessage(
    {
      id: 1,
      passengerType: 0,
      lastName: 'NGUYEN',
      firstName: 'THI OANH',
      title: 'MS',
      gender: false,
      dateOfBirth: null,
      source: 'operator_input',
      normalizedLastName: 'NGUYEN',
      normalizedFirstName: 'THI OANH',
      normalizedFullName: 'NGUYEN THI OANH',
      seenCount: 1,
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    },
    ['gender'],
  );
  const combinedText = [
    genericMessage,
    nameKnownMessage,
    genderKnownMessage,
    storedProfileMessage,
  ].join('\n');

  assert.match(genericMessage, /họ tên đầy đủ/);
  assert.match(genericMessage, /giới tính/);
  assert.match(genericMessage, /Nữ, Nguyễn Thị Oanh/);
  assert.match(genericMessage, /Nam, Nguyễn Văn A/);
  assert.match(nameKnownMessage, /Nữ, Nguyễn Thị Oanh/);
  assert.match(genderKnownMessage, /Nữ, <họ tên khách>/);
  assert.doesNotMatch(
    combinedText,
    /\bfullName\b|\bgender\b|\bemail\b|\bphone\b|điện thoại|hộ chiếu|căn cước/i,
  );
}

/**
 * Verifies native 1Booking quick input formatting and VN-only DOB preflight.
 */
function testPassengerQuickInputAndAirlineDobRules() {
  const femalePassenger = {
    gender: 'F' as const,
    lastName: 'NGUYEN',
    firstName: 'THI LANH',
    dob: null,
  };
  const flight = {
    cardIndex: 1,
    airlineCode: 'VJ',
    airlineName: 'Vietjet Air',
    flightNumber: 'VJ123',
    departureTime: '08:40',
    arrivalTime: '10:00',
    bookingClass: 'ECO' as const,
    priceText: 'VND 1,000,000',
    selectedAt: '2026-06-02T00:00:00.000Z',
  };

  assert.equal(
    buildPassengerQuickInput({
      gender: 'M',
      lastName: 'NGUYEN',
      firstName: 'VAN A',
      dob: null,
    }),
    'Mr NGUYEN/ VAN A',
  );
  assert.equal(
    buildPassengerQuickInput({
      ...femalePassenger,
      dob: '1995-01-02',
    }),
    'Ms NGUYEN/ THI LANH 02/01/1995',
  );
  assert.throws(() =>
    buildPassengerQuickInput({
      ...femalePassenger,
      gender: null,
    }),
  );
  assert.deepEqual(
    getMissingHoldPassengerFields({
      selectedFlight: flight,
      attachedPassengerInfo: femalePassenger,
    }),
    [],
  );
  assert.deepEqual(
    getMissingHoldPassengerFields({
      selectedFlight: {
        ...flight,
        airlineCode: 'VN',
        airlineName: 'Vietnam Airlines',
        flightNumber: 'VN123',
      },
      attachedPassengerInfo: femalePassenger,
    }),
    ['dob'],
  );
}

/**
 * Verifies that final hold automation permits only `Giữ chỗ`.
 *
 * Ticket issuance is permanently forbidden and must fail before any click.
 */
function testSafeFinalHoldCtaGuard() {
  assert.doesNotThrow(() => assertSafeFinalHoldCtaText('Giữ chỗ'));
  assert.doesNotThrow(() => assertSafeFinalHoldCtaText('Giu cho'));
  assert.throws(
    () => assertSafeFinalHoldCtaText('Xuất vé ngay'),
    /must never click "Xuất vé ngay"/,
  );
  assert.throws(() => assertSafeFinalHoldCtaText('Hủy'));
}

/**
 * Verifies PNR validation and extraction from one held-order card snapshot.
 */
function testHeldBookingPnrExtraction() {
  const exactFlightNumber = buildExactFlightNumberPattern('VJ634');

  assert.equal(exactFlightNumber.test('VJ634'), true);
  assert.equal(exactFlightNumber.test(' VJ634 '), true);
  assert.equal(exactFlightNumber.test('VJ634A321'), false);
  assert.equal(isValidPnrCode('VNT56E'), true);
  assert.equal(isValidPnrCode('#HS2200389000081'), false);
  assert.equal(isValidPnrCode('VJ630'), false);
  assert.equal(isValidPnrCode('H1_ECO'), false);
  assert.equal(isValidPnrCode('VNT56!'), false);
  assert.deepEqual(
    extractPnrCodesFromHeldOrderText(
      ['VJ630', 'H1_ECO', 'Đang giữ chỗ', 'VNT56E'].join('\n'),
      'VJ630',
    ),
    ['VNT56E'],
  );
}

/**
 * Verifies submitted hold failures require manual review instead of retry.
 */
function testSubmittedHoldFailureSafety() {
  const postSubmitError = new PostSubmitHoldError(
    'terminal_order_page',
    new Error('Order page timed out.'),
    'https://pro.1booking.vn/order/123',
  );

  assert.equal(
    getHoldAutomationFailureStatus(
      postSubmitError,
      false,
      true,
    ),
    'HOLD_NEEDS_REVIEW',
  );
  assert.equal(
    getHoldAutomationFailureStatus(new Error('Before final click.'), false, true),
    'HOLD_FAILED',
  );
  assert.equal(
    getHoldAutomationFailureStatus(new Error('Passenger fill failed.'), false, false),
    'FILL_PASSENGER_FAILED',
  );
  assert.equal(postSubmitError.checkpoint, 'terminal_order_page');
  assert.equal(postSubmitError.originalCauseMessage, 'Order page timed out.');
  assert.equal(postSubmitError.currentUrl, 'https://pro.1booking.vn/order/123');
  assert.equal(
    isDurableHeldOrderTerminalState({
      orderId: '#HS2200389000085',
      hasExpectedHeldFlight: true,
    }),
    true,
  );
  assert.equal(
    isDurableHeldOrderTerminalState({
      orderId: '#HS2200389000085',
      hasExpectedHeldFlight: false,
    }),
    false,
  );
  assert.equal(getPnrExtractionStatus('VNT56E'), 'PNR_EXTRACTED');
  assert.equal(getPnrExtractionStatus(null), 'HOLD_SUCCESS');
}

/**
 * Verifies auth refresh retries only before an irreversible hold submission.
 */
async function testOneBookingAuthRefreshRetryPolicy() {
  let refreshCount = 0;
  let noticeCount = 0;
  const controller = new OneBookingAuthRefreshRetryController({
    async onAuthRefresh() {
      noticeCount += 1;
    },
    async refreshAuthState() {
      refreshCount += 1;

      return {
        ok: true,
        storageStatePath: 'auth/1booking-storage-state.json',
      };
    },
    async appendLog() {},
  });

  assert.equal(
    await controller.refreshIfAuthExpired(
      new OneBookingAuthExpiredError('expired'),
      {
        irreversible: false,
      },
    ),
    true,
  );
  assert.equal(controller.authRefreshed, true);
  assert.equal(refreshCount, 1);
  assert.equal(noticeCount, 1);
  assert.equal(
    await controller.refreshIfAuthExpired(
      new OneBookingAuthExpiredError('expired again'),
      {
        irreversible: false,
      },
    ),
    false,
  );

  const postSubmitController = new OneBookingAuthRefreshRetryController({
    async refreshAuthState() {
      throw new Error('should not refresh');
    },
  });

  assert.equal(
    await postSubmitController.refreshIfAuthExpired(
      new OneBookingAuthExpiredError('expired after hold click'),
      {
        irreversible: true,
      },
    ),
    false,
  );
}

/**
 * Verifies explicit no-browser recovery for manually reviewed held bookings.
 */
async function testPassengerHoldRecovery() {
  const flightCase: LocalFlightCase = {
    caseId: 'BK-20260602-145601',
    status: 'HOLD_NEEDS_REVIEW' as const,
    rawMessage: 'test',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
  };
  let updatedCase: LocalFlightCase = flightCase;
  let markedPassengerCaseId: string | null = null;

  assert.deepEqual(parseHoldRecoveryMessage('hello'), {
    isRecoveryMessage: false,
  });
  assert.deepEqual(
    parseHoldRecoveryMessage('recover BK-20260602-145601 PNR HXGUQ9'),
    {
      isRecoveryMessage: true,
      ok: true,
      caseId: 'BK-20260602-145601',
      pnrCode: 'HXGUQ9',
    },
  );
  assert.equal(
    parseHoldRecoveryMessage('recover BK-20260602-145601 PNR BAD').ok,
    true,
  );
  assert.match(
    validateRecoverableHoldCase({
      ...flightCase,
      status: 'SEARCH_DONE',
    }) ?? '',
    /không ở trạng thái cần recover hold/,
  );

  const result = await recoverHeldBookingCase(
    {
      caseId: flightCase.caseId,
      pnrCode: 'HXGUQ9',
    },
    {
      async readCase() {
        return updatedCase;
      },
      async updateCase(_flightCase, patch) {
        updatedCase = {
          ...updatedCase,
          ...patch,
          updatedAt: '2026-06-02T00:01:00.000Z',
        };

        return updatedCase;
      },
      markPassengerSuccessfulHold(caseId) {
        markedPassengerCaseId = caseId;
      },
      async appendLog() {},
      now: () => '2026-06-02T00:01:00.000Z',
    },
  );

  assert.deepEqual(result, {
    ok: true,
    caseId: flightCase.caseId,
    pnrCode: 'HXGUQ9',
  });
  assert.equal(markedPassengerCaseId, flightCase.caseId);
  assert.equal(updatedCase.status, 'PNR_EXTRACTED');
  assert.equal(updatedCase.pnrCode, 'HXGUQ9');
  assert.equal(updatedCase.errorMessage, undefined);

  const malformed = await recoverHeldBookingCase(
    {
      caseId: flightCase.caseId,
      pnrCode: 'BAD',
    },
    {
      async readCase() {
        return flightCase;
      },
    },
  );

  assert.equal(malformed.ok, false);
}

/**
 * Verifies Telegram success includes PNR or a non-retry manual-check warning.
 */
function testPassengerHoldTelegramMessages() {
  assert.match(
    formatPassengerHoldSuccessMessage('BK-20260602-133338', 'VNT56E'),
    /PNR: VNT56E/,
  );
  assert.match(
    formatPassengerHoldSuccessMessage(
      'BK-20260602-133338',
      null,
      'Please check the existing order manually.',
    ),
    /PNR: Chưa extract được/,
  );
  assert.match(
    formatPassengerHoldNeedsReviewMessage('Order page timed out.'),
    /tránh giữ chỗ trùng/,
  );
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
  assert.equal(
    messageLooksLikePassengerInfo('case này lấy chuyến 13h30 Vietjet cho chị Oanh'),
    true,
  );
  assert.equal(
    messageLooksLikePassengerInfo('case này lấy chuyến 13h30 Vietjet'),
    false,
  );
}

/**
 * Verifies combined flow only auto-holds after passenger data is attached.
 */
function testCombinedSelectionPassengerHoldReadiness() {
  assert.equal(
    hasReadyPassengerForCombinedHold({
      attachedPassenger: undefined,
      attachedPassengerInfo: undefined,
    }),
    false,
  );
  assert.equal(
    hasReadyPassengerForCombinedHold({
      attachedPassenger: {
        id: 1,
        passengerType: 0,
        lastName: 'NGUYEN',
        firstName: 'THI OANH',
        title: 'MS',
        gender: false,
        dateOfBirth: null,
        source: 'operator_input',
        normalizedLastName: 'NGUYEN',
        normalizedFirstName: 'THI OANH',
        normalizedFullName: 'NGUYEN THI OANH',
        seenCount: 1,
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:00.000Z',
      },
      attachedPassengerInfo: {
        gender: 'F',
        lastName: 'NGUYEN',
        firstName: 'THI OANH',
        dob: null,
      },
    }),
    true,
  );
}

async function main() {
  prepareTestFiles();
  testPassengerMessageSchema();
  await testOpenAIPassengerMessageParser();
  testPassengerQuickInputParserContract();
  testPassengerResolverStates();
  testPassengerProfileEnrichment();
  testNewPassengerUpsertAndCaseAttachment();
  testIncompleteNewPassengerIsNotInserted();
  testPassengerDraftMergeForSplitInputs();
  testPassengerMissingFieldTelegramMessages();
  testPassengerQuickInputAndAirlineDobRules();
  testSafeFinalHoldCtaGuard();
  testHeldBookingPnrExtraction();
  testSubmittedHoldFailureSafety();
  await testOneBookingAuthRefreshRetryPolicy();
  await testPassengerHoldRecovery();
  testPassengerHoldTelegramMessages();
  testTelegramPassengerContextAndRouting();
  testCombinedSelectionPassengerHoldReadiness();

  console.log('Passenger message parser contract tests passed.');
}

main().catch((error) => {
  console.error('Passenger message parser contract tests failed:', error);
  process.exit(1);
});
