import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  Usage,
  type Model,
  type ModelResponse,
} from '@openai/agents';
import {
  createHybridSearchAgent,
  runHybridSearchTurn,
  type HybridSearchAutomation,
} from '../src/agent/hybrid-search-agent';
import {
  createEmptyHybridSearchSession,
  HybridSearchSessionStore,
} from '../src/storage/hybrid-search-session-store';
import type { FlightSearchSnapshot } from '../src/automation/1booking/flight-search-snapshot';
import {
  HYBRID_AIRPORT_CATALOG,
  parseHybridTimeConstraintFromVietnameseText,
} from '../src/agent/hybrid-flight-request';

type PlannedTool = { name: string; args: Record<string, unknown> };
type PlannedModelResponse = PlannedTool | null;

function fakeModel(plans: PlannedModelResponse[], callCount?: { value: number }): Model {
  let previous: PlannedModelResponse | undefined;
  return {
    async getResponse(request): Promise<ModelResponse> {
      // Old fixtures model a persistent bad proposal during the one allowed
      // repair. Protocol no-tool recovery still consumes its explicit next plan.
      const repairing = JSON.stringify(request).includes('Đọc lại một lần:');
      const next = repairing && previous ? previous : plans.shift();
      previous = next;
      if (next === undefined) throw new Error('No fake model response left.');
      if (callCount) callCount.value += 1;
      if (next === null) {
        return {
          usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 12 }),
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'free text that must not be forwarded' }],
          }],
        };
      }
      return {
        usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 12 }),
        output: [{
          type: 'function_call',
          callId: `call-${plans.length}`,
          name: next.name,
          arguments: JSON.stringify(
            next.name === 'search_flights' || next.name === 'compare_flights'
              ? { requestMode: 'update_search', ...next.args }
              : next.name === 'ask_operator_for_clarification' && next.args.purpose === 'clarify'
                ? { ...next.args, draftRequest: { requestMode: 'update_search', ...(next.args.draftRequest as object ?? {}) } }
                : next.args,
          ),
        }],
      };
    },
    async *getStreamedResponse() {
      throw new Error('Streaming is not used in this contract.');
    },
  };
}

function makeSnapshot(): FlightSearchSnapshot {
  return {
    snapshotId: 'FS-test-1',
    capturedAt: '2099-07-01T03:00:00.000Z',
    route: {
      fromAirportCode: 'SGN',
      fromAirportText: 'Sài Gòn',
      toAirportCode: 'HAN',
      toAirportText: 'Hà Nội',
    },
    departureDate: '2099-07-30',
    candidates: [0, 1, 2].map((cardIndex) => ({
      candidateId: `candidate-${cardIndex}`,
      cardIndex,
      airlineCode: 'VJ',
      airlineName: 'Vietjet',
      flightNumber: `VJ${100 + cardIndex}`,
      departureTime: `${String(8 + cardIndex).padStart(2, '0')}:00`,
      arrivalTime: `${String(10 + cardIndex).padStart(2, '0')}:00`,
      bookingClass: 'ECO',
      rawBookingClassCode: 'ECO',
      priceText: `${1_000_000 + cardIndex * 100_000} VND`,
      priceAmount: 1_000_000 + cardIndex * 100_000,
    })),
    screenshots: [{
      path: 'snapshot-1.png',
      candidateIds: ['candidate-0', 'candidate-1', 'candidate-2'],
    }],
    observedFlightCount: 3,
  };
}

const settings = {
  agentEnabled: true,
  autoSearchFlights: true,
  autoHoldBooking: false,
  requireConfirmationBeforeHold: true,
  debugMode: false,
};

async function main() {
  if (process.env.BOOKING_HYBRID_TEST_CHILD !== '1') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-search-'));
    try {
      execFileSync(process.execPath, [
        '--import', pathToFileURL(require.resolve('tsx')).href,
        __filename,
      ], {
        cwd: directory,
        stdio: 'inherit',
        env: {
          ...process.env,
          BOOKING_HYBRID_TEST_CHILD: '1',
          OPENAI_API_KEY: '',
          TELEGRAM_BOT_TOKEN: '',
          AGENT_ORCHESTRATION_MODE: 'hybrid_search',
        },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    return;
  }

  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search';
  const plainHour = parseHybridTimeConstraintFromVietnameseText('Đổi giờ bay17h nhé');
  assert.equal(plainHour?.kind, 'around');
  assert.equal(plainHour?.exactTime, '17:00');
  assert.equal(parseHybridTimeConstraintFromVietnameseText('Đúng 25h nhé'), null);
  assert.equal(parseHybridTimeConstraintFromVietnameseText('Đúng 08:99 nhé'), null);
  const temporaryStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-session-')),
  );
  const snapshot = makeSnapshot();
  let liveSearches = 0;
  const automation: HybridSearchAutomation = async (_input, options) => {
    liveSearches += 1;
    assert.equal(options?.fullSnapshot, true);
    assert.ok(options?.caseId);
    return {
      ok: true,
      candidates: snapshot.candidates,
      flightCount: 3,
      displayedFlightCount: 3,
      screenshotPath: 'snapshot-1.png',
      screenshotPaths: ['snapshot-1.png'],
      snapshot: {
        ...snapshot,
        snapshotId: `FS-test-${liveSearches}`,
      },
    };
  };

  const greetingStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-greeting-')),
  );
  const greeting = await runHybridSearchTurn(706, 'xin chào', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Chào bạn! Bạn gửi tuyến và ngày bay, mình sẽ giúp tìm chuyến nhé.',
        purpose: 'greeting',
        target: 'none',
      },
    }]),
    automation,
    sessionStore: greetingStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(greeting.status, 'clarification');
  assert.equal(greeting.toolName, 'ask_operator_for_clarification');
  assert.equal(greeting.liveSearchPerformed, false);

  const help = await runHybridSearchTurn(707, 'Bạn có mẫu gửi không?', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Bạn có thể gửi điểm đi, điểm đến và ngày bay, ví dụ HCM đến Qui Nhơn ngày 01/02.',
        purpose: 'help',
        target: 'none',
      },
    }]),
    automation,
    sessionStore: greetingStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(help.status, 'clarification');
  assert.equal(help.toolName, 'ask_operator_for_clarification');
  assert.equal(help.liveSearchPerformed, false);

  const canonicalBoundaryStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-clarification-boundary-')),
  );
  const catalogAirport = (code: string) => {
    const airport = HYBRID_AIRPORT_CATALOG.find((item) => item.code === code);
    assert.ok(airport, `test catalog airport ${code} exists`);
    return airport;
  };
  const forgedQuestionCases = [
    {
      fromCode: 'SGN',
      toCode: 'UIH',
      question: 'Bạn xác nhận Tân Sơn Nhất (HAN? ) đến UIH ngày 01/02/2027 nhé?',
      forbidden: ['HAN?', 'FAKEPNR123', '999999 VND'],
    },
    {
      fromCode: 'SGN',
      toCode: 'UIH',
      question: 'Điểm đi là Hà Nội (HAN), điểm đến là Sài Gòn (SGN), đúng không?',
      forbidden: ['HAN', 'Hà Nội'],
    },
    {
      fromCode: 'SGN',
      toCode: 'UIH',
      question: 'Điểm đi là Sân bay Atlantis (ZZZ), điểm đến là UIH.',
      forbidden: ['ZZZ', 'Atlantis'],
    },
    {
      fromCode: 'SGN',
      toCode: 'UIH',
      question: 'Giá 99.999.999 VND và PNR FAKEPNR123 đã được xác nhận cho tuyến này.',
      forbidden: ['FAKEPNR123', '99.999.999 VND'],
    },
    {
      fromCode: 'DAD',
      toCode: 'CXR',
      question: 'Bạn xác nhận Hà Nội (HAN) đến Cần Thơ (VCA) nhé?',
      forbidden: ['HAN', 'VCA', 'Hà Nội', 'Cần Thơ'],
    },
  ] as const;
  for (const [index, testCase] of forgedQuestionCases.entries()) {
    const chatId = 714 + index;
    const from = catalogAirport(testCase.fromCode);
    const to = catalogAirport(testCase.toCode);
    const seeded = createEmptyHybridSearchSession(chatId, 11);
    seeded.draftRequest = {
      fromAirportCode: from.code,
      fromAirportText: from.text,
      toAirportCode: to.code,
      toAirportText: to.text,
      departureDate: '2027-02-01',
      tripType: 'one_way',
    };
    await canonicalBoundaryStore.write(chatId, seeded);
    const result = await runHybridSearchTurn(chatId, `test clarification ${index}`, {
      model: fakeModel([{
        name: 'ask_operator_for_clarification',
        args: {
          question: testCase.question,
          purpose: 'clarify',
          target: 'time',
        },
      }]),
      automation,
      sessionStore: canonicalBoundaryStore,
      ownerTelegramUserId: 11,
      settingsReader: async () => settings,
    });
    assert.equal(result.status, 'clarification');
    assert.ok(result.response.includes(from.text), `response uses catalog origin ${from.code}`);
    assert.ok(result.response.includes(to.text), `response uses catalog destination ${to.code}`);
    for (const forbidden of testCase.forbidden) {
      assert.ok(!result.response.includes(forbidden), `response excludes forged value ${forbidden}`);
    }
    const persisted = await canonicalBoundaryStore.read(chatId);
    assert.equal(persisted?.draftRequest?.fromAirportCode, from.code);
    assert.equal(persisted?.draftRequest?.toAirportCode, to.code);
    assert.equal(persisted?.draftRequest?.departureDate, '2027-02-01');
    const lastAssistant = persisted?.history.at(-1)?.content ?? '';
    assert.equal(lastAssistant, result.response);
    assert.ok(!lastAssistant.includes(testCase.question), 'legacy question is not persisted as assistant text');
  }

  for (let index = 0; index < HYBRID_AIRPORT_CATALOG.length; index += 1) {
    const from = HYBRID_AIRPORT_CATALOG[index];
    const to = HYBRID_AIRPORT_CATALOG[(index + 1) % HYBRID_AIRPORT_CATALOG.length];
    const chatId = 800 + index;
    const seeded = createEmptyHybridSearchSession(chatId, 11);
    seeded.draftRequest = {
      fromAirportCode: from.code,
      fromAirportText: from.text,
      toAirportCode: to.code,
      toAirportText: to.text,
      departureDate: '2027-02-01',
      tripType: 'one_way',
    };
    await canonicalBoundaryStore.write(chatId, seeded);
    const result = await runHybridSearchTurn(chatId, 'catalog greeting', {
      model: fakeModel([{
        name: 'ask_operator_for_clarification',
        args: {
          question: 'Tuyến giả HAN đến CXR; giá 99.999.999 VND PNR FAKEPNR123.',
          purpose: 'greeting',
          target: 'none',
        },
      }]),
      automation,
      sessionStore: canonicalBoundaryStore,
      ownerTelegramUserId: 11,
      settingsReader: async () => settings,
    });
    assert.equal(result.status, 'clarification');
    assert.ok(result.response.includes(from.text), `greeting uses catalog origin ${from.code}`);
    assert.ok(result.response.includes(to.text), `greeting uses catalog destination ${to.code}`);
    assert.match(result.response, /01\/02\/2027/);
    assert.doesNotMatch(result.response, /FAKEPNR123|99\.999\.999 VND/);
    assert.doesNotMatch(result.response, /Tuyến giả/);
    const persisted = await canonicalBoundaryStore.read(chatId);
    assert.equal(persisted?.history.at(-1)?.content, result.response);
  }

  const greetingPatchChatId = 719;
  const greetingSeed = createEmptyHybridSearchSession(greetingPatchChatId, 11);
  greetingSeed.draftRequest = {
    fromAirportCode: 'SGN',
    fromAirportText: catalogAirport('SGN').text,
    toAirportCode: 'UIH',
    toAirportText: catalogAirport('UIH').text,
    departureDate: '2027-02-01',
    tripType: 'one_way',
  };
  await canonicalBoundaryStore.write(greetingPatchChatId, greetingSeed);
  const greetingWithBogusPatch = await runHybridSearchTurn(greetingPatchChatId, 'xin chào', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Tân Sơn Nhất (HAN? ) giá 99.999.999 VND PNR FAKEPNR123.',
        purpose: 'greeting',
        target: 'none',
        draftRequest: {
          fromAirportCode: 'HAN',
          fromAirportText: catalogAirport('HAN').text,
          toAirportCode: 'CXR',
          toAirportText: catalogAirport('CXR').text,
          departureDate: '2030-03-04',
        },
      },
    }]),
    automation,
    sessionStore: canonicalBoundaryStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(greetingWithBogusPatch.status, 'clarification');
  assert.match(greetingWithBogusPatch.response, /Sân bay Tân Sơn Nhất \(SGN\)/);
  assert.match(greetingWithBogusPatch.response, /Phu Cat Airport \(UIH\)/);
  assert.match(greetingWithBogusPatch.response, /01\/02\/2027/);
  assert.match(greetingWithBogusPatch.response, /tiếp tục tìm chuyến/);
  assert.doesNotMatch(greetingWithBogusPatch.response, /HAN|CXR|FAKEPNR123|99\.999\.999 VND/);
  const greetingPersisted = await canonicalBoundaryStore.read(greetingPatchChatId);
  assert.equal(greetingPersisted?.draftRequest?.fromAirportCode, 'SGN');
  assert.equal(greetingPersisted?.draftRequest?.toAirportCode, 'UIH');
  assert.equal(greetingPersisted?.draftRequest?.departureDate, '2027-02-01');
  assert.equal(greetingPersisted?.history.at(-1)?.content, greetingWithBogusPatch.response);

  const helpPatchChatId = 720;
  const helpSeed = createEmptyHybridSearchSession(helpPatchChatId, 11);
  helpSeed.draftRequest = { ...greetingSeed.draftRequest };
  await canonicalBoundaryStore.write(helpPatchChatId, helpSeed);
  const helpWithBogusPatch = await runHybridSearchTurn(helpPatchChatId, 'Bạn có mẫu gửi không?', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Mẫu giả có PNR FAKEPNR123 và sân bay HAN.',
        purpose: 'help',
        target: 'none',
        draftRequest: {
          fromAirportCode: 'HAN',
          fromAirportText: catalogAirport('HAN').text,
          departureDate: '2030-03-04',
        },
      },
    }]),
    automation,
    sessionStore: canonicalBoundaryStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(helpWithBogusPatch.status, 'clarification');
  assert.match(helpWithBogusPatch.response, /Từ \[điểm đi\] đến \[điểm đến\] ngày DD\/MM\/YYYY/);
  assert.doesNotMatch(helpWithBogusPatch.response, /HAN|FAKEPNR123/);
  const helpPersisted = await canonicalBoundaryStore.read(helpPatchChatId);
  assert.equal(helpPersisted?.draftRequest?.fromAirportCode, 'SGN');
  assert.equal(helpPersisted?.draftRequest?.toAirportCode, 'UIH');
  assert.equal(helpPersisted?.draftRequest?.departureDate, '2027-02-01');
  assert.equal(helpPersisted?.history.at(-1)?.content, helpWithBogusPatch.response);

  const legacyPatchChatId = 721;
  const legacySeed = createEmptyHybridSearchSession(legacyPatchChatId, 11);
  legacySeed.draftRequest = { ...greetingSeed.draftRequest };
  await canonicalBoundaryStore.write(legacyPatchChatId, legacySeed);
  const legacyQuestion = 'Tuyến HAN đến CXR giá 99.999.999 VND PNR FAKEPNR123.';
  const legacyClarification = await runHybridSearchTurn(legacyPatchChatId, 'legacy adapter', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: legacyQuestion,
        draftRequest: {
          fromAirportCode: 'HAN',
          fromAirportText: catalogAirport('HAN').text,
          toAirportCode: 'CXR',
          toAirportText: catalogAirport('CXR').text,
          departureDate: '2030-03-04',
        },
      },
    }]),
    automation,
    sessionStore: canonicalBoundaryStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(legacyClarification.status, 'clarification');
  assert.doesNotMatch(legacyClarification.response, /HAN|CXR|FAKEPNR123|99\.999\.999 VND/);
  const legacyPersisted = await canonicalBoundaryStore.read(legacyPatchChatId);
  assert.equal(legacyPersisted?.draftRequest?.fromAirportCode, 'SGN');
  assert.equal(legacyPersisted?.draftRequest?.toAirportCode, 'UIH');
  assert.equal(legacyPersisted?.draftRequest?.departureDate, '2027-02-01');
  assert.equal(legacyPersisted?.history.at(-1)?.content, legacyClarification.response);
  assert.ok(!legacyPersisted?.history.at(-1)?.content.includes(legacyQuestion));

  const conflictChatId = 722;
  const conflictSeed = createEmptyHybridSearchSession(conflictChatId, 11);
  conflictSeed.draftRequest = { ...greetingSeed.draftRequest };
  await canonicalBoundaryStore.write(conflictChatId, conflictSeed);
  const conflictingDraft = await runHybridSearchTurn(conflictChatId, 'xác nhận lại điểm đi', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Mình thấy Tân Sơn Nhất (HAN), bạn xác nhận nhé?',
        purpose: 'clarify',
        target: 'route',
        draftRequest: {
          fromAirportCode: 'HAN',
          fromAirportText: 'Tân Sơn Nhất (HAN)',
          toAirportCode: 'UIH',
          toAirportText: catalogAirport('UIH').text,
        },
      },
    }]),
    automation,
    sessionStore: canonicalBoundaryStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(conflictingDraft.status, 'clarification');
  assert.match(conflictingDraft.response, /xác nhận.*điểm đi/);
  assert.doesNotMatch(conflictingDraft.response, /điểm đến/);
  assert.doesNotMatch(conflictingDraft.response, /HAN|Tân Sơn Nhất/);
  const conflictPersisted = await canonicalBoundaryStore.read(conflictChatId);
  assert.equal(conflictPersisted?.draftRequest?.fromAirportCode, 'SGN');
  assert.equal(conflictPersisted?.draftRequest?.toAirportCode, 'UIH');

  const dualConflictChatId = 723;
  const dualConflictSeed = createEmptyHybridSearchSession(dualConflictChatId, 11);
  dualConflictSeed.draftRequest = { ...greetingSeed.draftRequest };
  await canonicalBoundaryStore.write(dualConflictChatId, dualConflictSeed);
  const dualConflict = await runHybridSearchTurn(dualConflictChatId, 'xác nhận lại tuyến', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Điểm đi Hà Nội (HAN), điểm đến Cần Thơ (VCA), xác nhận nhé?',
        purpose: 'clarify',
        target: 'route',
        draftRequest: {
          fromAirportCode: 'HAN',
          fromAirportText: catalogAirport('SGN').text,
          toAirportCode: 'CXR',
          toAirportText: catalogAirport('UIH').text,
        },
      },
    }]),
    automation,
    sessionStore: canonicalBoundaryStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(dualConflict.status, 'clarification');
  assert.match(dualConflict.response, /điểm đi.*điểm đến/);
  const dualConflictPersisted = await canonicalBoundaryStore.read(dualConflictChatId);
  assert.equal(dualConflictPersisted?.draftRequest?.fromAirportCode, 'SGN');
  assert.equal(dualConflictPersisted?.draftRequest?.toAirportCode, 'UIH');

  const recoveryStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-recovery-')),
  );
  const recoverySnapshot: FlightSearchSnapshot = {
    ...makeSnapshot(),
    snapshotId: 'FS-recovery',
    route: {
      fromAirportCode: 'SGN',
      fromAirportText: 'Sân bay Tân Sơn Nhất (SGN)',
      toAirportCode: 'UIH',
      toAirportText: 'Phu Cat Airport (UIH)',
    },
    departureDate: '2027-02-01',
  };
  let recoveryInput: Record<string, unknown> | undefined;
  const recoveryAutomation: HybridSearchAutomation = async (input, options) => {
    recoveryInput = input as unknown as Record<string, unknown>;
    assert.equal(options?.fullSnapshot, true);
    return {
      ok: true,
      candidates: recoverySnapshot.candidates,
      flightCount: recoverySnapshot.observedFlightCount,
      displayedFlightCount: recoverySnapshot.candidates.length,
      screenshotPath: 'recovery.png',
      screenshotPaths: ['recovery.png'],
      snapshot: recoverySnapshot,
    };
  };
  const recoveryFirst = await runHybridSearchTurn(
    708,
    'Mình muốn tìm chuyến từ HCM đến sân bay Phù Cát vào ngày 1/2 năm sau',
    {
      model: fakeModel([{
        name: 'ask_operator_for_clarification',
        args: {
          question: 'Bạn cho mình biết giờ bay mong muốn nhé?',
          purpose: 'clarify',
          target: 'time',
          draftRequest: {
            fromAirportCode: null,
            fromAirportText: 'HCM',
            toAirportCode: 'UIH',
            toAirportText: 'Phù Cát',
            departureDate: '2027-02-01',
            tripType: 'one_way',
          },
        },
      }]),
      automation: recoveryAutomation,
      sessionStore: recoveryStore,
      ownerTelegramUserId: 11,
      todayIso: '2026-09-14',
      now: new Date('2026-09-14T02:00:00.000Z'),
      settingsReader: async () => settings,
    },
  );
  assert.equal(recoveryFirst.status, 'clarification');
  const persistedRecoveryDraft = (await recoveryStore.read(708))?.draftRequest;
  assert.equal(persistedRecoveryDraft?.fromAirportCode, 'SGN');
  assert.equal(persistedRecoveryDraft?.toAirportCode, 'UIH');
  assert.equal(persistedRecoveryDraft?.departureDate, '2027-02-01');
  const brokenPersistedSession = await recoveryStore.read(708);
  assert.ok(brokenPersistedSession);
  await recoveryStore.write(708, {
    ...brokenPersistedSession,
    draftRequest: {
      ...brokenPersistedSession.draftRequest,
      fromAirportCode: null,
      fromAirportText: 'HCM',
    },
  });

  const recoverySecond = await runHybridSearchTurn(
    708,
    'điểm đi là HCM và điểm đến là Qui Nhơn',
    {
      model: fakeModel([{
        name: 'search_flights',
        args: { fromAirportText: 'HCM', toAirportText: 'Qui Nhơn' },
      }]),
      automation: recoveryAutomation,
      sessionStore: recoveryStore,
      ownerTelegramUserId: 11,
      todayIso: '2026-09-14',
      now: new Date('2026-09-14T02:00:00.000Z'),
      settingsReader: async () => settings,
    },
  );
  assert.equal(recoverySecond.status, 'searched');
  assert.equal(recoveryInput?.fromAirportCode, 'SGN');
  assert.equal(recoveryInput?.toAirportCode, 'UIH');
  assert.equal(recoveryInput?.departureDate, '2027-02-01', 'follow-up without a date retains the persisted yearful date');

  const protocolStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-protocol-')),
  );
  const clarificationCalls = { value: 0 };
  const recoveredClarification = await runHybridSearchTurn(709, 'xin chào', {
    model: fakeModel([
      null,
      {
        name: 'ask_operator_for_clarification',
        args: {
          question: 'Chào bạn! Bạn gửi tuyến và ngày bay để mình tìm chuyến nhé.',
          purpose: 'greeting',
          target: 'none',
        },
      },
    ], clarificationCalls),
    automation,
    sessionStore: protocolStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(recoveredClarification.status, 'clarification');
  assert.equal(recoveredClarification.toolName, 'ask_operator_for_clarification');
  assert.equal(clarificationCalls.value, 2, 'one no-tool completion gets one protocol retry');
  assert.deepEqual(recoveredClarification.usage, {
    requests: 2,
    inputTokens: 20,
    outputTokens: 24,
    totalTokens: 44,
  });

  let protocolSearches = 0;
  const protocolAutomation: HybridSearchAutomation = async (_input, options) => {
    protocolSearches += 1;
    assert.equal(options?.fullSnapshot, true);
    return {
      ok: true,
      candidates: snapshot.candidates,
      flightCount: 3,
      displayedFlightCount: 3,
      screenshotPath: 'protocol.png',
      screenshotPaths: ['protocol.png'],
      snapshot: { ...snapshot, snapshotId: `FS-protocol-${protocolSearches}` },
    };
  };
  const searchCalls = { value: 0 };
  const recoveredSearch = await runHybridSearchTurn(710, 'SGN đi HAN ngày 30/07', {
    model: fakeModel([
      null,
      {
        name: 'search_flights',
        args: {
          fromAirportCode: 'SGN', fromAirportText: 'Sài Gòn',
          toAirportCode: 'HAN', toAirportText: 'Hà Nội', departureDate: '2099-07-30',
        },
      },
    ], searchCalls),
    automation: protocolAutomation,
    sessionStore: protocolStore,
    ownerTelegramUserId: 11,
    todayIso: '2099-07-01',
    now: new Date('2099-07-01T01:00:00.000Z'),
    settingsReader: async () => settings,
  });
  assert.equal(recoveredSearch.status, 'searched');
  assert.equal(searchCalls.value, 2);
  assert.equal(protocolSearches, 1);

  const boundedCalls = { value: 0 };
  const boundedLogs: Array<{ failureReason?: string }> = [];
  const boundedNoTool = await runHybridSearchTurn(711, 'xin chào', {
    model: fakeModel([null, null], boundedCalls),
    automation,
    sessionStore: protocolStore,
    ownerTelegramUserId: 11,
    logger: (entry) => boundedLogs.push(entry),
    settingsReader: async () => settings,
  });
  assert.equal(boundedNoTool.status, 'error');
  assert.equal(boundedCalls.value, 2, 'two no-tool completions stop after one retry');
  assert.match(boundedNoTool.response, /chưa xử lý được lượt này/);
  assert.equal(boundedLogs[0]?.failureReason, 'model_returned_without_tool');

  const toolCalls = { value: 0 };
  const firstTool = await runHybridSearchTurn(712, 'xin chào', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Bạn gửi tuyến và ngày bay giúp mình nhé.',
        purpose: 'greeting',
        target: 'none',
      },
    }], toolCalls),
    automation,
    sessionStore: protocolStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(firstTool.status, 'clarification');
  assert.equal(toolCalls.value, 1, 'a completed tool turn never retries');

  const failedSearchCalls = { value: 0 };
  const failedSearch = await runHybridSearchTurn(713, 'SGN đi HAN ngày 30/07', {
    model: fakeModel([{
      name: 'search_flights',
      args: {
        fromAirportCode: 'SGN', fromAirportText: 'Sài Gòn',
        toAirportCode: 'HAN', toAirportText: 'Hà Nội', departureDate: '2099-07-30',
      },
    }], failedSearchCalls),
    automation: async () => ({ ok: false, message: 'browser search failed' }),
    sessionStore: protocolStore,
    ownerTelegramUserId: 11,
    todayIso: '2099-07-01',
    now: new Date('2099-07-01T01:00:00.000Z'),
    settingsReader: async () => settings,
  });
  assert.equal(failedSearch.status, 'error');
  assert.equal(failedSearch.liveSearchPerformed, true);
  assert.equal(failedSearchCalls.value, 1, 'a failed executed search never retries the model');

  const model = fakeModel([
    {
      name: 'ask_operator_for_clarification',
      args: {
        question: 'Bạn cho mình biết giờ sớm nhất có thể bay nhé?',
        purpose: 'clarify',
        target: 'time',
        draftRequest: {
          fromAirportCode: 'SGN', fromAirportText: 'Sài Gòn',
          toAirportCode: 'HAN', toAirportText: 'Hà Nội',
          departureDate: '2099-07-30', tripType: 'one_way',
        },
      },
    },
    {
      name: 'search_flights',
      args: {
        timeConstraint: {
          kind: 'from', startTime: '08:00', endTime: null, exactTime: null,
          startInclusive: true, endInclusive: false,
        },
      },
    },
    { name: 'compare_flights', args: { criterion: 'cheapest' } },
    { name: 'search_flights', args: { refresh: true } },
    { name: 'compare_flights', args: { candidateIds: ['forged-id'], criterion: 'earliest' } },
    {
      name: 'search_flights',
      args: {
        timeConstraint: {
          kind: 'exact', startTime: null, endTime: null, exactTime: '25:00',
          startInclusive: true, endInclusive: true,
        },
      },
    },
    { name: 'search_flights', args: { preferredAirlineCodes: ['ZZ'] } },
    { name: 'search_flights', args: { departureDate: '2020-01-01' } },
  ]);

  const first = await runHybridSearchTurn(700, 'SGN đi HAN ngày 30/07, đừng quá sớm', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(first.status, 'clarification');
  assert.equal((await temporaryStore.read(700))?.draftRequest?.departureDate, '2099-07-30');

  const second = await runHybridSearchTurn(700, 'Từ 8 giờ nhé', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(second.status, 'searched');
  assert.equal(liveSearches, 1);
  assert.match(second.response, /VJ100/);

  const third = await runHybridSearchTurn(700, 'Cho mình giá rẻ nhất trong kết quả vừa tìm', {
    model,
    automation,
    sessionStore: new HybridSearchSessionStore(temporaryStoreDirectory(temporaryStore)),
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(third.status, 'compared');
  assert.equal(liveSearches, 1, 'same route/date comparison must use the cache');
  assert.match(third.response, /1,000,000|1\.000\.000/);

  const fourth = await runHybridSearchTurn(700, 'Làm mới kết quả giúp mình', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(fourth.status, 'searched');
  assert.equal(liveSearches, 2);

  const validSearchState = await temporaryStore.read(700);
  assert.ok(validSearchState);
  const badId = await runHybridSearchTurn(700, 'So sánh chuyến sớm nhất', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(badId.status, 'invalid');
  assert.equal(liveSearches, 2);

  const malformedTime = await runHybridSearchTurn(700, 'Đúng 25h nhé', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(malformedTime.status, 'clarification');
  assert.equal(liveSearches, 2, 'malformed time must never reach automation');
  // Independent malformed-input scenarios start from a verified request; pending fields are tested separately.
  await temporaryStore.write(700, validSearchState);

  const unknownAirline = await runHybridSearchTurn(700, 'Tìm hãng ZZ', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(unknownAirline.status, 'clarification');
  assert.equal(liveSearches, 2, 'unknown airline must never reach automation');
  // Independent malformed-input scenarios start from a verified request; pending fields are tested separately.
  await temporaryStore.write(700, validSearchState);

  const pastDate = await runHybridSearchTurn(700, 'Tìm ngày 01/01/2020', {
    model,
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(pastDate.status, 'clarification');
  assert.equal(liveSearches, 2, 'past date must never reach automation');
  // Independent malformed-input scenarios start from a verified request; pending fields are tested separately.
  await temporaryStore.write(700, validSearchState);

  const noMatch = await runHybridSearchTurn(700, 'Sau 23h nhé', {
    model: fakeModel([{ name: 'search_flights', args: {
      timeConstraint: {
        kind: 'from', startTime: '23:00', endTime: null, exactTime: null,
        startInclusive: true, endInclusive: false,
      },
    } }]),
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(noMatch.status, 'no_match');
  assert.equal(liveSearches, 2, 'same route/date no-match must use cache');
  const aroundCompare = await runHybridSearchTurn(700, 'Đổi giờ bay17h nhé, ưu tiên sớm nhất', {
    model: fakeModel([{ name: 'compare_flights', args: {
      criterion: 'earliest',
      timeConstraint: {
        kind: 'around', startTime: null, endTime: null, exactTime: '17:00',
        startInclusive: true, endInclusive: true,
      },
    } }]),
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(aroundCompare.status, 'no_match');
  assert.match(aroundCompare.response, /15:00.*19:00/);

  const wrongDirectionalModel = await runHybridSearchTurn(700, 'Sau 10h nhé, ưu tiên sớm nhất', {
    model: fakeModel([{ name: 'compare_flights', args: {
      criterion: 'earliest',
      timeConstraint: {
        kind: 'from', startTime: '10:00', endTime: null, exactTime: null,
        startInclusive: true, endInclusive: false,
      },
    } }]),
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(wrongDirectionalModel.status, 'no_match', 'raw sau10h must be exclusive even when model says from');
  assert.match(wrongDirectionalModel.response, /sau 10:00/);

  const aroundStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-around-')),
  );
  const aroundSnapshot: FlightSearchSnapshot = {
    ...makeSnapshot(),
    snapshotId: 'FS-around',
    candidates: [
      { ...makeSnapshot().candidates[0], departureTime: '16:00', arrivalTime: '18:00' },
    ],
    screenshots: [{ path: 'snapshot-1.png', candidateIds: ['candidate-0'] }],
  };
  const aroundSearch = await runHybridSearchTurn(704, 'SGN HAN 30/07 bay17h', {
    model: fakeModel([{ name: 'search_flights', args: {
      fromAirportCode: 'SGN', fromAirportText: 'Sài Gòn',
      toAirportCode: 'HAN', toAirportText: 'Hà Nội', departureDate: '2099-07-30',
      timeConstraint: {
        kind: 'exact', startTime: null, endTime: null, exactTime: '17:00',
        startInclusive: true, endInclusive: true,
      },
    } }]),
    automation: async () => ({
      ok: true,
      candidates: aroundSnapshot.candidates,
      flightCount: 1,
      displayedFlightCount: 1,
      screenshotPath: 'snapshot-1.png',
      screenshotPaths: ['snapshot-1.png'],
      snapshot: aroundSnapshot,
    }),
    sessionStore: aroundStore,
    settingsReader: async () => settings,
    todayIso: '2099-07-01',
  });
  assert.equal(aroundSearch.status, 'searched');
  assert.match(aroundSearch.response, /VJ100.*16:00/);

  const rateLimitLogs: Array<{ failureReason?: string; modelName?: string }> = [];
  const rateStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-rate-')),
  );
  const rateLimitedModel: Model = {
    async getResponse() {
      throw new Error('429 rate_limit');
    },
    async *getStreamedResponse() {
      throw new Error('429 rate_limit');
    },
  };
  const rateLimited = await runHybridSearchTurn(705, 'Tìm SGN HAN 30/07', {
    model: rateLimitedModel,
    sessionStore: rateStore,
    settingsReader: async () => settings,
    logger: (entry) => rateLimitLogs.push(entry),
    todayIso: '2099-07-01',
  });
  assert.equal(rateLimited.status, 'error');
  assert.match(rateLimited.response, /Dịch vụ AI.*giới hạn lượt xử lý/);
  assert.match(rateLimitLogs[0]?.failureReason ?? '', /429 rate_limit/);
  assert.equal(rateLimitLogs[0]?.modelName, 'injected-model');

  const offStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-off-')),
  );
  let offSearches = 0;
  const offAutomation: HybridSearchAutomation = async (...args) => {
    offSearches += 1;
    return automation(...args);
  };
  const disabled = await runHybridSearchTurn(701, 'SGN HAN 30/07', {
    model: fakeModel([{ name: 'search_flights', args: {
      fromAirportCode: 'SGN', toAirportCode: 'HAN', departureDate: '2099-07-30',
    } }]),
    automation: offAutomation,
    sessionStore: offStore,
    settingsReader: async () => ({ ...settings, agentEnabled: false }),
    todayIso: '2099-07-01',
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(offSearches, 0);
  const autoOff = await runHybridSearchTurn(702, 'SGN HAN 30/07', {
    model: fakeModel([{ name: 'search_flights', args: {
      fromAirportCode: 'SGN', toAirportCode: 'HAN', departureDate: '2099-07-30',
    } }]),
    automation: offAutomation,
    sessionStore: offStore,
    settingsReader: async () => ({ ...settings, autoSearchFlights: false }),
    todayIso: '2099-07-01',
  });
  assert.equal(autoOff.status, 'disabled');
  assert.equal(offSearches, 0);

  const unrankableStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-unrankable-')),
  );
  const unrankableSnapshot: FlightSearchSnapshot = {
    ...makeSnapshot(),
    snapshotId: 'FS-unrankable',
    candidates: makeSnapshot().candidates.map((candidate) => ({
      ...candidate,
      priceText: null,
      priceAmount: null,
    })),
  };
  const unrankable = await runHybridSearchTurn(703, 'SGN HAN 30/07 giá rẻ nhất', {
    model: fakeModel([{ name: 'search_flights', args: {
      fromAirportCode: 'SGN', fromAirportText: 'Sài Gòn',
      toAirportCode: 'HAN', toAirportText: 'Hà Nội',
      departureDate: '2099-07-30', resultRanking: 'cheapest',
    } }]),
    automation: async (_input, options) => ({
      ok: true,
      candidates: unrankableSnapshot.candidates,
      flightCount: 3,
      displayedFlightCount: 3,
      screenshotPath: 'snapshot-1.png',
      screenshotPaths: ['snapshot-1.png'],
      snapshot: unrankableSnapshot,
      caseId: options?.caseId,
    }),
    sessionStore: unrankableStore,
    settingsReader: async () => settings,
    todayIso: '2099-07-01',
  });
  assert.equal(unrankable.status, 'searched');
  assert.match(unrankable.response, /chưa có giá hiển thị|chưa chọn đại/i);
  assert.doesNotMatch(unrankable.response, /VJ100.*VND/);

  const failingRefresh = await runHybridSearchTurn(700, 'Làm mới lại nhé', {
    model: fakeModel([{ name: 'search_flights', args: { refresh: true } }]),
    automation: async () => ({ ok: false, message: 'browser search failed' }),
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    now: new Date('2099-07-01T01:00:00.000Z'),
    todayIso: '2099-07-01',
    settingsReader: async () => settings,
  });
  assert.equal(failingRefresh.status, 'error');
  assert.equal((await temporaryStore.read(700))?.snapshotFresh, false);
  assert.ok((await temporaryStore.read(700))?.snapshot, 'failed refresh retains the prior snapshot');
  const staleCompare = await runHybridSearchTurn(700, 'So sánh giá rẻ nhất', {
    model: fakeModel([{ name: 'compare_flights', args: { criterion: 'cheapest' } }]),
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    settingsReader: async () => settings,
  });
  assert.equal(staleCompare.status, 'invalid');
  assert.equal(liveSearches, 2, 'stale comparison must not auto-retry a failed refresh');

  assert.deepEqual((await runHybridSearchTurn(700, 'Nội dung trống?', {
    model: fakeModel([{ name: 'ask_operator_for_clarification', args: {
      question: 'Bạn cho mình thêm ngày bay nhé?',
      purpose: 'clarify',
      target: 'date',
    } }]),
    automation,
    sessionStore: temporaryStore,
    settingsReader: async () => settings,
  })).screenshotBatches, [], 'clarification keeps Telegram response arrays defined');

  const replay = await runHybridSearchTurn(700, 'Từ 8 giờ nhé', {
    model: fakeModel([{ name: 'search_flights', args: {} }]),
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    messageId: 42,
    settingsReader: async () => settings,
  });
  const replayAgain = await runHybridSearchTurn(700, 'Từ 8 giờ nhé', {
    model: fakeModel([{ name: 'search_flights', args: { refresh: true } }]),
    automation,
    sessionStore: temporaryStore,
    ownerTelegramUserId: 11,
    messageId: 42,
    settingsReader: async () => settings,
  });
  assert.notEqual(replay.status, 'duplicate');
  assert.equal(replayAgain.status, 'duplicate');
  assert.equal(liveSearches, 3, 'failed refresh counts as one attempted live search');

  const context = {
    chatId: 1,
    text: 'test',
    session: (await temporaryStore.read(700))!,
    sessionStore: temporaryStore,
    automation,
    settingsReader: async () => settings,
    now: new Date(),
    liveSearchPerformed: false,
  };
  const agent = createHybridSearchAgent(context, fakeModel([{ name: 'inspect_case', args: {} }]));
  assert.deepEqual(
    agent.tools.map((item) => item.name).sort(),
    ['ask_operator_for_clarification', 'compare_flights', 'inspect_case', 'search_flights'].sort(),
  );
  assert.ok(!agent.tools.some((item) => /hold|passenger|select|pnr/i.test(item.name)));

  const ledgerStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-ledger-')),
  );
  for (let index = 0; index <= 130; index += 1) {
    assert.equal(await ledgerStore.claimMessageId(900, index), true);
  }
  const restartedStore = new HybridSearchSessionStore(temporaryStoreDirectory(ledgerStore));
  assert.equal((await restartedStore.read(900))?.processedMessageIds.length, 131);
  assert.equal(await restartedStore.claimMessageId(900, 0), false, 'replay ledger survives >100 messages and restart');
  let active = 0;
  let maximumActive = 0;
  await Promise.all(Array.from({ length: 4 }, (_, index) => ledgerStore.runExclusive(901, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 8 : 2));
    active -= 1;
  })));
  assert.equal(maximumActive, 1, 'per-chat store lock serializes concurrent turns');

  await fs.writeFile(sessionFilePath(ledgerStore, 902), JSON.stringify({
    version: 1, chatId: 999, history: [], processedMessageIds: [], snapshotFresh: false,
  }));
  await assert.rejects(() => ledgerStore.read(902), /different Telegram chat/);
  await fs.writeFile(sessionFilePath(ledgerStore, 903), JSON.stringify({
    version: 2, chatId: 903, history: [], processedMessageIds: [], snapshotFresh: false,
  }));
  await assert.rejects(() => ledgerStore.read(903), /version is unsupported/);
  await fs.writeFile(sessionFilePath(ledgerStore, 904), JSON.stringify({
    version: 1, chatId: 904, snapshot: 'corrupt', snapshotFresh: false,
    history: [], processedMessageIds: [],
  }));
  await assert.rejects(() => ledgerStore.read(904), /snapshot is malformed/);

  const lifecycleStore = new HybridSearchSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'booking-hybrid-lifecycle-')),
  );
  const lifecycleModelCalls = { value: 0 };
  let lifecycleHookCalls = 0;
  let lifecycleModelCallsAtHook: number | undefined;
  let lifecycleClaimed = false;
  let lifecycleHistoryRole: string | undefined;
  const lifecycle = await runHybridSearchTurn(930, 'Tìm chuyến từ SGN đến HAN', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: { purpose: 'clarify', target: 'date', draftRequest: { fromAirportCode: 'SGN', toAirportCode: 'HAN' } },
    }], lifecycleModelCalls),
    sessionStore: lifecycleStore,
    ownerTelegramUserId: 11,
    messageId: 'lifecycle-1',
    settingsReader: async () => settings,
    onProcessingStarted: async () => {
      lifecycleHookCalls += 1;
      lifecycleModelCallsAtHook = lifecycleModelCalls.value;
      const claimedSession = await lifecycleStore.read(930);
      lifecycleClaimed = Boolean(claimedSession?.processedMessageIds.includes('lifecycle-1'));
      lifecycleHistoryRole = claimedSession?.history.at(-1)?.role;
    },
  });
  assert.equal(lifecycle.status, 'clarification');
  assert.equal(lifecycleHookCalls, 1);
  assert.equal(lifecycleModelCallsAtHook, 0, 'processing hook runs before model work');
  assert.equal(lifecycleClaimed, true, 'processing hook runs after the durable message claim');
  assert.equal(lifecycleHistoryRole, 'user');
  assert.equal(lifecycleModelCalls.value, 1);

  let duplicateHookCalls = 0;
  const duplicateModelCalls = { value: 0 };
  const duplicateLifecycle = await runHybridSearchTurn(930, 'Tìm lại nhé', {
    model: fakeModel([null], duplicateModelCalls),
    sessionStore: lifecycleStore,
    ownerTelegramUserId: 11,
    messageId: 'lifecycle-1',
    settingsReader: async () => settings,
    onProcessingStarted: () => { duplicateHookCalls += 1; },
  });
  assert.equal(duplicateLifecycle.status, 'duplicate');
  assert.equal(duplicateHookCalls, 0, 'duplicate turns do not send processing feedback');
  assert.equal(duplicateModelCalls.value, 0, 'duplicate turns do not run the model');

  let disabledHookCalls = 0;
  const disabledModelCalls = { value: 0 };
  const disabledLifecycle = await runHybridSearchTurn(931, 'Tìm chuyến từ SGN đến HAN', {
    model: fakeModel([null], disabledModelCalls),
    sessionStore: lifecycleStore,
    ownerTelegramUserId: 11,
    messageId: 'disabled-1',
    settingsReader: async () => ({ ...settings, agentEnabled: false }),
    onProcessingStarted: () => { disabledHookCalls += 1; },
  });
  assert.equal(disabledLifecycle.status, 'disabled');
  assert.equal(disabledHookCalls, 0, 'disabled turns do not send processing feedback');
  assert.equal(disabledModelCalls.value, 0, 'disabled turns do not run the model');

  const failedHookModelCalls = { value: 0 };
  const failedHookLifecycle = await runHybridSearchTurn(932, 'Tìm chuyến từ SGN đến HAN', {
    model: fakeModel([{
      name: 'ask_operator_for_clarification',
      args: { purpose: 'clarify', target: 'date', draftRequest: { fromAirportCode: 'SGN', toAirportCode: 'HAN' } },
    }], failedHookModelCalls),
    sessionStore: lifecycleStore,
    ownerTelegramUserId: 11,
    messageId: 'failed-hook-1',
    settingsReader: async () => settings,
    onProcessingStarted: () => { throw new Error('synthetic acknowledgement failure'); },
  });
  assert.equal(failedHookLifecycle.status, 'clarification');
  assert.equal(failedHookModelCalls.value, 1, 'processing feedback failure does not abort the turn');

  await Promise.all([
    fs.rm(temporaryStoreDirectory(temporaryStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(greetingStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(recoveryStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(protocolStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(offStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(unrankableStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(aroundStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(rateStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(ledgerStore), { recursive: true, force: true }),
    fs.rm(temporaryStoreDirectory(lifecycleStore), { recursive: true, force: true }),
  ]);
  console.log('Hybrid search pilot contracts passed: SDK tools, clarification persistence, cache filtering, refresh, bad IDs, replay and tool boundary.');
}

function temporaryStoreDirectory(store: HybridSearchSessionStore) {
  // The class intentionally keeps its path private; tests only need an
  // independent store for a restart read, so use the default path from the
  // test's private temporary directory through a harmless cast.
  return (store as unknown as { directory: string }).directory;
}

function sessionFilePath(store: HybridSearchSessionStore, chatId: number) {
  return path.join(
    temporaryStoreDirectory(store),
    `${createHash('sha256').update(String(chatId)).digest('hex')}.json`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
