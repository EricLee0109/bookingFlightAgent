import {
  Agent,
  Runner,
  assistant,
  tool,
  user,
  type Model,
  type RunContext,
} from '@openai/agents';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  ProposalMetadataShape, validateSearchProposal, formatProposalIssues,
  airportCodesInText, type ProposalIssue, type ProposalFieldResult, type SearchProposal,
} from './hybrid-search-proposal';
import {
  HybridTimeConstraintSchema,
  HYBRID_AIRPORT_CATALOG,
  normalizeHybridRequest,
  parseHybridTimeConstraintFromVietnameseText,
  resolveHybridDepartureDate,
  validateHybridFlightRequest,
  type HybridSearchFlightRequest,
  type HybridTimeConstraint,
} from './hybrid-flight-request';
import {
  filterFlightSearchSnapshot,
  isSameFlightSearchRouteAndDate,
  screenshotsForFlightSearchResult,
  type FlightSearchSnapshot,
  type FlightSearchSnapshotCandidate,
  type FlightSearchSnapshotFilterResult,
} from '../automation/1booking/flight-search-snapshot';
import type { SearchFlightsInput } from '../automation/1booking/search-flight-input';
import {
  searchOneBookingFlights,
  type FlightSearchAutomationOptions,
  type FlightSearchAutomationResult,
} from '../services/flight-search-automation-service';
import {
  createLocalFlightCase,
  readLocalFlightCase,
  updateLocalFlightCase,
} from '../storage/local-case-store';
import {
  createEmptyHybridSearchSession,
  assertHybridSearchSessionOwner,
  HybridSearchSessionStore,
  type HybridSearchChatMessage,
  type HybridSearchSession,
  type HybridSearchSessionStoreLike,
} from '../storage/hybrid-search-session-store';
import {
  readLocalAgentSettings,
  type AgentSettings,
} from '../storage/local-settings-store';
import { appendLocalLog } from '../storage/local-log-store';
import {
  resolveAirportByCode,
  type ResolvedAirport,
} from './airport-resolver';
import {
  readAgentOrchestrationMode,
  redactAgentMessage,
} from './booking-agent-policy';
import {
  createAIConnection,
  getAIModel,
  sanitizeAIError,
} from './ai-provider';

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_MODEL_TIMEOUT_MS = 15_000;
const MAX_HISTORY_ITEMS = 16;
const MAX_MODEL_CANDIDATES = 100;

/** Search automation is injectable so SDK tests never need a browser. */
export type HybridSearchAutomation = (
  input: SearchFlightsInput,
  options?: FlightSearchAutomationOptions,
) => Promise<FlightSearchAutomationResult>;

export type HybridSearchSettingsReader = () => Promise<AgentSettings>;

export type HybridSearchLogEntry = {
  mode: 'hybrid_search';
  toolName: string;
  modelName?: string;
  success: boolean;
  turnId?: string;
  outcomeStatus?: HybridSearchTurnStatus;
  resolvedRequestMode?: SearchProposal['requestMode'];
  confirmedIntent?: boolean;
  repairAttempts?: number;
  liveSearchPerformed?: boolean;
  validation?: ProposalFieldResult[];
  validationAttempts?: ProposalFieldResult[][];
  latencyMs: number;
  caseId?: string;
  snapshotId?: string;
  /** Sanitized internal category/message; never sent to Telegram. */
  failureReason?: string;
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type HybridSearchAgentOptions = {
  /** A real Agents SDK Model or a deterministic test adapter. */
  model?: Model | string;
  /** Defaults to searchOneBookingFlights. */
  automation?: HybridSearchAutomation;
  /** Defaults to a private file-backed store. */
  sessionStore?: HybridSearchSessionStoreLike;
  /** Authenticated Telegram identity used for session ownership. */
  ownerTelegramUserId?: number;
  /** Telegram message id used for replay protection. */
  messageId?: number | string;
  /** Injectable clock for date/time contract tests. */
  now?: Date;
  todayIso?: string;
  /** Applies only to model calls; browser search has its own service lifecycle. */
  modelTimeoutMs?: number;
  maxTurns?: number;
  settingsReader?: HybridSearchSettingsReader;
  /** Best-effort notification after replay/settings guards and durable claim. */
  onProcessingStarted?: () => void | Promise<void>;
  logger?: (entry: HybridSearchLogEntry) => void | Promise<void>;
};

type HybridSearchAgentBuildOptions = {
  /** Adds one strict protocol reminder after a provider returns no tool call. */
  protocolRecovery?: boolean;
  proposalRecovery?: boolean;
};

/** Resolves the bounded model timeout, with an optional validated env default. */
export function resolveHybridModelTimeout(
  optionValue?: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (optionValue !== undefined) {
    return validateModelTimeout(optionValue, 'modelTimeoutMs');
  }
  const configuredValue = env.HYBRID_SEARCH_MODEL_TIMEOUT_MS?.trim();
  if (!configuredValue) return DEFAULT_MODEL_TIMEOUT_MS;
  return validateModelTimeout(
    Number(configuredValue),
    'HYBRID_SEARCH_MODEL_TIMEOUT_MS',
  );
}

export type HybridSearchTurnStatus =
  | 'clarification'
  | 'inspected'
  | 'compared'
  | 'searched'
  | 'no_match'
  | 'disabled'
  | 'unauthorized'
  | 'duplicate'
  | 'busy'
  | 'invalid'
  | 'unsupported'
  | 'error';

export type HybridSearchScreenshotBatch = {
  path: string;
  candidateIds: string[];
};

export type HybridSearchTurnResult = {
  ok: boolean;
  status: HybridSearchTurnStatus;
  /** Customer-facing Vietnamese response. */
  response: string;
  /** Alias for callers that use message terminology. */
  message: string;
  caseId?: string;
  snapshotId?: string;
  snapshot?: FlightSearchSnapshot;
  screenshotPaths: string[];
  screenshotBatches: HybridSearchScreenshotBatch[];
  capturedAt?: string;
  liveSearchPerformed: boolean;
  toolName?: string;
  duplicate?: boolean;
  pagination?: { token: string; page: number; pageCount: number; total: number };
  usage?: HybridSearchLogEntry['usage'];
};

export type HybridSearchAgentContext = {
  chatId: number;
  text: string;
  session: HybridSearchSession;
  sessionStore: HybridSearchSessionStoreLike;
  automation: HybridSearchAutomation;
  settingsReader: HybridSearchSettingsReader;
  now: Date;
  todayIso?: string;
  ownerTelegramUserId?: number;
  liveSearchPerformed: boolean;
  outcome?: HybridToolOutcome;
  decisionToolUsed?: boolean;
  repairNeeded?: boolean;
  intentDraftForTurn?: Partial<HybridSearchFlightRequest>;
  resolvedRequestMode?: SearchProposal['requestMode'];
  confirmedIntent?: boolean;
  proposalIssues?: ProposalIssue[];
  fieldResults?: ProposalFieldResult[];
  validationAttempts?: ProposalFieldResult[][];
  toolName?: string;
  /** Sanitized tool failure category retained only for internal logging. */
  failureReason?: string;
};

type HybridToolOutcome = {
  resultFilter?: FlightSearchSnapshotFilterResult;
  status: HybridSearchTurnStatus;
  response: string;
  caseId?: string;
  snapshotId?: string;
  snapshot?: FlightSearchSnapshot;
  screenshotPaths?: string[];
  screenshotBatches?: HybridSearchScreenshotBatch[];
  capturedAt?: string;
  liveSearchPerformed?: boolean;
};

// HybridSearchFlightRequestSchema has a superRefine for round trips, so Zod
// intentionally refuses `.partial()` on it. Keep the model patch schema
// shape-based and run the complete request through the stage1 validator before
// any automation is allowed.
const RequestPatchSchema = z.object({
  ...ProposalMetadataShape,
  fromAirportCode: z.string().nullable().optional(),
  fromAirportText: z.string().nullable().optional(),
  toAirportCode: z.string().nullable().optional(),
  toAirportText: z.string().nullable().optional(),
  departureDate: z.string().nullable().optional(),
  returnDate: z.string().nullable().optional(),
  preferredTime: z.enum([
    'early_morning', 'morning', 'afternoon', 'night', 'specific_time',
  ]).nullable().optional(),
  specificTime: z.string().nullable().optional(),
  resultRanking: z.literal('cheapest').nullable().optional(),
  preferredAirlineCodes: z.array(z.string()).nullable().optional(),
  tripType: z.enum(['one_way', 'round_trip']).optional(),
  missingFields: z.array(z.string()).optional(),
  timeConstraint: HybridTimeConstraintSchema.nullable().optional(),
  /** Explicitly clear a retained criterion; omitted fields are retained. */
  clearFields: z.array(z.string()).max(16).optional(),
  refresh: z.boolean().optional(),
}).strict();

type RequestPatch = z.infer<typeof RequestPatchSchema>;

const ClarificationSchema = z.object({
  /** Legacy model wording is accepted for adapter compatibility and ignored. */
  question: z.string().max(1000).nullable().optional(),
  /**
   * Structured intent for the deterministic customer-facing renderer.
   * Optional keeps older model adapters parseable; missing values fail closed.
   */
  purpose: z.enum(['greeting', 'help', 'clarify', 'unsupported']).optional(),
  target: z.enum(['route', 'date', 'time', 'threshold', 'ranking', 'none']).optional(),
  reason: z.enum(['missing_information', 'unsupported_request']).optional(),
  draftRequest: RequestPatchSchema.optional(),
}).strict();

const CompareSchema = z.object({
  ...ProposalMetadataShape,
  criterion: z.enum(['cheapest', 'earliest', 'latest']).optional(),
  preferredTime: z.enum([
    'early_morning', 'morning', 'afternoon', 'night', 'specific_time',
  ]).nullable().optional(),
  specificTime: z.string().nullable().optional(),
  timeConstraint: HybridTimeConstraintSchema.nullable().optional(),
  preferredAirlineCodes: z.array(z.string()).nullable().optional(),
  resultRanking: z.literal('cheapest').nullable().optional(),
  candidateIds: z.array(z.string().min(1).max(80)).max(MAX_MODEL_CANDIDATES).optional(),
  snapshotId: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(5).optional(),
  clearFields: z.array(z.string()).max(16).optional(),
}).strict();

type ClarificationInput = z.infer<typeof ClarificationSchema>;
type CompareInput = z.infer<typeof CompareSchema>;
type ClarificationPurpose = NonNullable<ClarificationInput['purpose']>;
type ClarificationTarget = NonNullable<ClarificationInput['target']>;
type ResolvedClarificationPurpose = ClarificationPurpose | 'legacy';
type ConflictingAirportSide = 'from' | 'to';

const EmptySchema = z.object({}).strict();

/**
 * Creates the only SDK agent used by the search pilot.
 *
 * Selection, passenger resolution, hold approval and legacy recovery are
 * deliberately absent from this tool list. The application owns those flows.
 */
export function createHybridSearchAgent(
  context: HybridSearchAgentContext,
  model?: Model | string,
  buildOptions: HybridSearchAgentBuildOptions = {},
) {
  const tools = [
    tool({
      name: 'ask_operator_for_clarification',
      description: [
        'Choose one structured purpose and target when route, date, time, or a supported criterion is missing or ambiguous.',
        'Send purpose, target and draftRequest when user facts are available. The application renders the customer-facing Vietnamese question from those structured fields and the validated draft.',
        'The legacy question field is optional, ignored and must not be used for customer facts.',
        'For booking, hold, passenger, selection or PNR requests, set reason=unsupported_request and explain the pilot boundary.',
        'Retain the supplied draftRequest only for purpose=clarify. Never invent airport, date, time, airline, fare, or flight values.',
      ].join(' '),
      parameters: ClarificationSchema,
      execute: async (input: ClarificationInput) => executeClarification(context, input),
    }),
    tool({
      name: 'inspect_case',
      description: 'Inspect the trusted current hybrid-search draft and immutable snapshot. This never opens a browser or selects a flight.',
      parameters: EmptySchema,
      execute: async () => executeInspect(context),
    }),
    tool({
      name: 'search_flights',
      description: [
        'Validate a complete or partially retained one-way request and search 1Booking at most once for this user turn.',
        'Use refresh=true only when the operator explicitly asks for a new live observation; same route/date follow-ups use the cached snapshot.',
        'The application validates all airport, airline, date, time, support and ownership rules before browser work.',
      ].join(' '),
      parameters: RequestPatchSchema,
      execute: async (input: RequestPatch) => executeSearch(context, input),
    }),
    tool({
      name: 'compare_flights',
      description: [
        'Filter or compare the current immutable snapshot without a browser call.',
        'Use criterion cheapest, earliest, or latest. For a snapshot with more than 30 candidates, omit candidateIds so code compares the complete verified snapshot.',
      ].join(' '),
      parameters: CompareSchema,
      execute: async (input: CompareInput) => executeCompare(context, input),
    }),
  ];

  return new Agent<HybridSearchAgentContext>({
    name: 'HybridSearchSearchAgent',
    model: model ?? getAIModel(DEFAULT_MODEL),
    modelSettings: {
      parallelToolCalls: false,
      toolChoice: 'required',
      timeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
    },
    toolUseBehavior: 'stop_on_first_tool',
    instructions: () => buildHybridInstructions(context, buildOptions),
    tools,
  });
}

/**
 * Runs one bounded SDK turn under the chat's serialization lock.
 *
 * A model timeout only surrounds the model request. If the model has already
 * selected search_flights, the browser call is allowed to finish and the
 * durable session is written before the next chat turn can start.
 */
export async function runHybridSearchTurn(
  chatId: number,
  text: string,
  options: HybridSearchAgentOptions = {},
): Promise<HybridSearchTurnResult> {
  const store = options.sessionStore ?? new HybridSearchSessionStore();
  const run = () => runHybridSearchTurnLocked(chatId, text, options, store);
  return store.runExclusive ? store.runExclusive(chatId, run) : run();
}

/** View tokens are UI cursors only; business IDs remain case/snapshot/candidate IDs. */
function resultViewRequestKey(session: HybridSearchSession) {
  return createHash('sha256').update(JSON.stringify([
    session.draftRequest, session.lastCompareCriterion ?? null,
  ])).digest('hex');
}

/** Read another page without involving the model or browser. */
export async function runHybridSearchPage(
  chatId: number,
  token: string,
  page: number,
  options: HybridSearchAgentOptions = {},
): Promise<HybridSearchTurnResult> {
  const store = options.sessionStore ?? new HybridSearchSessionStore();
  const run = async () => {
    if (readAgentOrchestrationMode() !== 'hybrid_search'
      || !(await safelyReadSettings(options.settingsReader ?? readLocalAgentSettings)).agentEnabled) {
      return createTurnResult('disabled', 'Agent hiện đang tắt.');
    }
    const session = await store.read(chatId);
    const stale = () => createTurnResult('invalid', 'Trang kết quả này không còn phù hợp với yêu cầu hiện tại. Bạn nhắn “xem lại kết quả” để mở danh sách mới nhất nhé.');
    const view = session?.resultView;
    const snapshot = session?.snapshot;
    if (!session || session.chatId !== chatId || !view || !snapshot
      || !session.snapshotFresh || session.snapshotId !== snapshot.snapshotId
      || view.snapshotId !== snapshot.snapshotId || token !== view.token
      || view.requestKey !== resultViewRequestKey(session)
      || session.pendingClarification?.fields.length) return stale();
    assertHybridSearchSessionOwner(session, options.ownerTelegramUserId);
    const messageId = options.messageId === undefined ? undefined : String(options.messageId);
    if (messageId && session.processedMessageIds.includes(messageId)) {
      return createTurnResult('duplicate', '', { duplicate: true });
    }
    if (!Number.isSafeInteger(page) || page < 0 || page >= Math.ceil(view.candidateIds.length / view.pageSize)) return stale();
    const now = options.now ?? new Date();
    const validation = validateHybridFlightRequest(toCompleteRequest(session.draftRequest ?? {}), { now, todayIso: options.todayIso });
    if (!validation.ok || !isSameFlightSearchRouteAndDate(snapshot, validation.request)) return stale();
    try {
      const filter = filterFlightSearchSnapshot(snapshot, {
        ...toSnapshotFilterRequest(validation.request, session.lastCompareCriterion),
        candidateIds: view.candidateIds, snapshotId: view.snapshotId,
        limit: view.pageSize, offset: page * view.pageSize,
      }, { now, todayIso: options.todayIso });
      // Reject a cursor if time eligibility or the verified ordering has changed.
      if (JSON.stringify(filter.rankedCandidateIds) !== JSON.stringify(view.candidateIds)) return stale();
      const result = createTurnResult('inspected', formatSnapshotResponse(snapshot, filter, 'trong danh sách đã lưu'), {
        caseId: session.caseId, snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt,
        screenshotBatches: screenshotsForSelected(snapshot, filter.selectedCandidates),
        pagination: { token, page, pageCount: Math.ceil(view.candidateIds.length / view.pageSize), total: view.candidateIds.length },
        toolName: 'view_results_page',
      });
      if (messageId) {
        session.processedMessageIds.push(messageId);
        await store.write(chatId, session);
      }
      return result;
    } catch {
      return stale();
    }
  };
  return store.runExclusive ? store.runExclusive(chatId, run) : run();
}

async function runHybridSearchTurnLocked(
  chatId: number,
  text: string,
  options: HybridSearchAgentOptions,
  store: HybridSearchSessionStoreLike,
): Promise<HybridSearchTurnResult> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return createTurnResult('invalid', 'Bạn gửi giúp mình nội dung yêu cầu tìm chuyến bay nhé.');
  }

  let mode: ReturnType<typeof readAgentOrchestrationMode>;
  try {
    mode = readAgentOrchestrationMode();
  } catch {
    return createTurnResult('error', 'Pilot tìm chuyến đang cấu hình chưa hợp lệ.');
  }
  if (mode !== 'hybrid_search') {
    return createTurnResult('disabled', 'Pilot tìm chuyến hiện chưa được bật.');
  }

  let session = await store.read(chatId);
  if (!session) session = createEmptyHybridSearchSession(chatId, options.ownerTelegramUserId);

  try {
    assertHybridSearchSessionOwner(session, options.ownerTelegramUserId);
  } catch {
    return createTurnResult('unauthorized', 'Cuộc trò chuyện này đã thuộc về một operator khác.');
  }

  if (session.ownerTelegramUserId === undefined && options.ownerTelegramUserId !== undefined) {
    session.ownerTelegramUserId = options.ownerTelegramUserId;
  }

  const messageId = options.messageId === undefined ? undefined : String(options.messageId);
  if (messageId && session.processedMessageIds.includes(messageId)) {
    return createTurnResult('duplicate', '', {
      duplicate: true,
      caseId: session.caseId,
      snapshotId: session.snapshotId,
    });
  }

  const settingsReader = options.settingsReader ?? readLocalAgentSettings;
  const initialSettings = await safelyReadSettings(settingsReader);
  if (!initialSettings.agentEnabled) {
    return createTurnResult('disabled', 'Agent hiện đang tắt. Bạn dùng /agent_on để bật lại nhé.');
  }

  if (messageId) {
    session.processedMessageIds = [...session.processedMessageIds, messageId];
  }
  const safeUserText = redactAgentMessage(normalizedText, false);
  session.history = appendHistory(session.history, { role: 'user', content: safeUserText });
  session.updatedAt = new Date().toISOString();
  await store.write(chatId, session);

  if (options.onProcessingStarted) {
    try {
      await options.onProcessingStarted();
    } catch {
      // A progress acknowledgement is best effort and must not affect the turn.
    }
  }

  const context: HybridSearchAgentContext = {
    chatId,
    text: normalizedText,
    session,
    sessionStore: store,
    automation: options.automation ?? searchOneBookingFlights,
    settingsReader,
    now: options.now ?? new Date(),
    todayIso: options.todayIso,
    ownerTelegramUserId: options.ownerTelegramUserId,
    liveSearchPerformed: false,
  };
  const startedAt = Date.now();
  const turnId = randomUUID();
  let repairAttempts = 0;
  let result: HybridSearchTurnResult;
  let usage: HybridSearchLogEntry['usage'];
  let failureReason: string | undefined;
  let modelName: string | undefined;

  try {
    const modelTimeoutMs = resolveHybridModelTimeout(options.modelTimeoutMs);
    const requestedModel = options.model ?? getAIModel(DEFAULT_MODEL);
    const connection = typeof requestedModel === 'string'
      ? createAIConnection({ model: requestedModel, defaultModel: DEFAULT_MODEL, maxRetries: 0 })
      : undefined;
    modelName = typeof requestedModel === 'string' ? requestedModel : 'injected-model';
    const boundedModel = typeof requestedModel === 'string'
      ? requestedModel
      : createBoundedModel(requestedModel, modelTimeoutMs);
    const agent = createHybridSearchAgent(context, boundedModel);
    agent.modelSettings.timeoutMs = modelTimeoutMs;
    const runner = new Runner({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: 'hybrid-search-pilot',
      groupId: `telegram:${chatId}`,
      ...(connection ? { modelProvider: connection.modelProvider } : {}),
    });
    const priorHistory = session.history
      .slice(0, -1)
      .map((item) => item.role === 'user' ? user(item.content) : assistant(item.content));
    // One SDK decision per run; protocol and proposal recovery share one extra run.
    const maxTurns = 1;
    const sdkResult = await runner.run(
      agent,
      [...priorHistory, user(safeUserText)],
      {
        maxTurns,
        context,
      },
    );
    usage = sanitizeUsage(sdkResult.state.usage);
    let outcome = context.outcome;
    if (!context.liveSearchPerformed && ((!outcome && !context.toolName) || context.repairNeeded)) {
      // Some OpenAI-compatible providers can return a normal text completion
      // despite tool_choice=required. Give the same user input one bounded
      // protocol-recovery decision, with no chance to repeat a tool run.
      repairAttempts = 1;
      const proposalRecovery = context.repairNeeded === true;
      const previousOutcome = outcome;
      const previousToolName = context.toolName;
      context.decisionToolUsed = false;
      context.toolName = undefined;
      context.outcome = undefined;
      context.repairNeeded = false;
      const recoveryAgent = createHybridSearchAgent(
        context,
        boundedModel,
        { protocolRecovery: !proposalRecovery, proposalRecovery },
      );
      recoveryAgent.modelSettings.timeoutMs = modelTimeoutMs;
      try {
        const recoveryResult = await runner.run(
          recoveryAgent,
          [...priorHistory, user(safeUserText)],
          { maxTurns, context },
        );
        usage = addUsage(usage, sanitizeUsage(recoveryResult.state.usage));
      } catch (error) {
        if (!previousOutcome) throw error;
        context.failureReason = sanitizeInternalFailure(error);
      }
      outcome = context.outcome ?? previousOutcome;
      context.toolName ??= previousToolName;
    }
    failureReason = context.failureReason;

    if (!outcome) {
      failureReason = 'model_returned_without_tool';
      result = createTurnResult(
        'error',
        'Mình chưa xử lý được lượt này. Bạn gửi lại tuyến, ngày, giờ hoặc tiêu chí tìm/so sánh giúp mình nhé.',
        { toolName: context.toolName, usage },
      );
    } else {
      const filter = outcome.resultFilter;
      let pagination: HybridSearchTurnResult['pagination'];
      if (filter?.selectedCandidates.length && outcome.snapshotId) {
        const view = {
          token: randomUUID(), snapshotId: outcome.snapshotId,
          candidateIds: filter.rankedCandidateIds,
          pageSize: filter.selectedCandidates.length,
          requestKey: resultViewRequestKey(context.session),
        };
        context.session.resultView = view;
        pagination = { token: view.token, page: 0, pageCount: Math.ceil(view.candidateIds.length / view.pageSize), total: view.candidateIds.length };
      } else if (filter) {
        context.session.resultView = undefined;
      }
      result = createTurnResult(outcome.status, outcome.response, {
        pagination,
        caseId: outcome.caseId,
        snapshotId: outcome.snapshotId,
        snapshot: outcome.snapshot,
        screenshotPaths: outcome.screenshotPaths,
        screenshotBatches: outcome.screenshotBatches,
        capturedAt: outcome.capturedAt,
        liveSearchPerformed: outcome.liveSearchPerformed ?? context.liveSearchPerformed,
        toolName: context.toolName,
        usage,
      });
    }
  } catch (error) {
    failureReason = sanitizeInternalFailure(error);
    result = createTurnResult(
      'error',
      classifyModelFailure(error),
      { toolName: context.toolName, usage, liveSearchPerformed: context.liveSearchPerformed },
    );
  }

  session = context.session;
  session.history = appendHistory(session.history, {
    role: 'assistant',
    content: redactAgentMessage(result.response, false),
  });
  session.updatedAt = new Date().toISOString();
  await store.write(chatId, session);

  await safeLog(options.logger, {
    mode: 'hybrid_search',
    turnId,
    outcomeStatus: result.status,
    resolvedRequestMode: context.resolvedRequestMode,
    confirmedIntent: context.confirmedIntent,
    repairAttempts,
    liveSearchPerformed: context.liveSearchPerformed,
    validation: context.fieldResults,
    validationAttempts: context.validationAttempts,
    toolName: context.toolName ?? 'none',
    modelName,
    success: result.ok,
    latencyMs: Date.now() - startedAt,
    caseId: result.caseId ?? session.caseId,
    snapshotId: result.snapshotId ?? session.snapshotId,
    usage,
    failureReason,
  });

  return result;
}

async function executeClarification(
  context: HybridSearchAgentContext,
  input: ClarificationInput,
) {
  if (!claimDecisionTool(context, 'ask_operator_for_clarification')) return context.outcome?.response ?? 'Lượt này đã xử lý một công cụ.';
  const purpose = resolveClarificationPurpose(input);
  if (purpose === 'clarify' && input.reason !== 'unsupported_request') {
    if (!acceptSearchProposal(context, input.draftRequest ?? {})) return context.outcome!.response;
  }
  const previousDraft = context.session.draftRequest;
  const mergedDraft = mergeHybridRequestDraft(
    previousDraft,
    {},
    undefined,
  );
  const conflictingSides = findConflictingAirportSides(mergedDraft);
  const safeMergedDraft = conflictingSides.length > 0
    ? preserveOrRemoveConflictingAirportSides(mergedDraft, previousDraft, conflictingSides)
    : mergedDraft;
  const draft = normalizeDraftForPersistence(
    safeMergedDraft,
    context.text,
    context.now,
    context.todayIso,
  );
  context.session.draftRequest = draft;
  if (purpose === 'clarify') {
    const target = resolveClarificationTarget(input, draft, conflictingSides);
    const redundant = (target === 'route' && draft.fromAirportCode && draft.toAirportCode)
      || (target === 'date' && draft.departureDate);
    if (redundant) context.repairNeeded = true;
  }
  const response = renderClarificationResponse(
    purpose,
    resolveClarificationTarget(input, draft, conflictingSides),
    draft,
    conflictingSides,
  );
  context.outcome = {
    status: purpose === 'unsupported' ? 'unsupported' : 'clarification',
    response,
  };
  return response;
}

/** Maps legacy reason metadata to a safe renderer mode without trusting prose. */
function resolveClarificationPurpose(input: ClarificationInput): ResolvedClarificationPurpose {
  if (input.reason === 'unsupported_request') return 'unsupported';
  if (input.purpose) return input.purpose;
  return 'legacy';
}

/** Derives a missing-field target only when an older adapter omitted one. */
function resolveClarificationTarget(
  input: ClarificationInput,
  draft: Partial<HybridSearchFlightRequest>,
  conflictingSides: readonly ConflictingAirportSide[] = [],
): ClarificationTarget {
  if (conflictingSides.length > 0) return 'route';
  if (input.target) return input.target;
  const route = resolveCanonicalRoute(draft);
  if (!route.from || !route.to) return 'route';
  if (!draft.departureDate) return 'date';
  return 'none';
}

/**
 * Renders every customer-visible clarification from closed structured data.
 * The model's free-form question is deliberately never used at this boundary.
 */
function renderClarificationResponse(
  purpose: ResolvedClarificationPurpose,
  target: ClarificationTarget,
  draft: Partial<HybridSearchFlightRequest>,
  conflictingSides: readonly ConflictingAirportSide[] = [],
) {
  if (purpose === 'greeting') {
    return renderGreetingResponse(draft);
  }
  if (purpose === 'help') {
    return 'Bạn có thể gửi theo mẫu: “Từ [điểm đi] đến [điểm đến] ngày DD/MM/YYYY; thêm khung giờ hoặc tiêu chí nếu muốn.”';
  }
  if (purpose === 'unsupported') {
    return 'Pilot này chỉ hỗ trợ tìm và so sánh chuyến bay một chiều; mình chưa thực hiện chọn chuyến, nhập hành khách, giữ chỗ hoặc lấy PNR nhé.';
  }

  const route = resolveCanonicalRoute(draft);
  if (target === 'route' || !route.from || !route.to) {
    return renderRouteClarification(route, conflictingSides);
  }

  const routeReference = renderCanonicalRouteReference(route);
  if (target === 'date') {
    return `Bạn cho mình biết ngày bay nhé. ${routeReference}`;
  }
  if (target === 'time') {
    return `Bạn cho mình biết khung giờ bay mong muốn nhé. ${routeReference}`;
  }
  if (target === 'threshold') {
    return `Bạn cho mình biết khung giờ hoặc mốc giờ cụ thể hơn nhé. ${routeReference}`;
  }
  if (target === 'ranking') {
    return `Bạn muốn ưu tiên giá rẻ nhất, chuyến sớm nhất hay chuyến muộn nhất? ${routeReference}`;
  }
  return 'Bạn cho mình biết thêm tiêu chí tìm hoặc so sánh nhé.';
}

/** Greets without discarding a valid retained route/date or asking for it again. */
function renderGreetingResponse(draft: Partial<HybridSearchFlightRequest>) {
  const route = resolveCanonicalRoute(draft);
  if (!route.from || !route.to) {
    return `Chào bạn! ${renderRouteClarification(route)}`;
  }
  if (!isUsableIsoDate(draft.departureDate)) {
    return `Chào bạn! Mình đang có thông tin chặng ${route.from.text} → ${route.to.text}. Bạn cho mình biết ngày bay nhé.`;
  }
  return `Chào bạn! Mình đang có thông tin chặng ${route.from.text} → ${route.to.text} ngày ${formatVietnameseDate(draft.departureDate)}. Bạn muốn mình tiếp tục tìm chuyến hay đổi tiêu chí?`;
}

function resolveCanonicalRoute(draft: Partial<HybridSearchFlightRequest>) {
  return {
    from: resolveCanonicalAirport(draft.fromAirportCode, draft.fromAirportText),
    to: resolveCanonicalAirport(draft.toAirportCode, draft.toAirportText),
  };
}

/** Collects every catalog airport named in one draft label for conflict checks. */
function findKnownAirportCodes(value: unknown): string[] {
  return typeof value === 'string' ? airportCodesInText(value) : [];
}

/** Rejects only contradictory known code/name pairs before normalization. */
function findConflictingAirportSides(
  draft: Partial<HybridSearchFlightRequest> | undefined,
): ConflictingAirportSide[] {
  if (!draft) return [];
  const conflictingSides: ConflictingAirportSide[] = [];
  for (const side of ['from', 'to'] as const) {
    const codeValue = draft[`${side}AirportCode`];
    const textValue = draft[`${side}AirportText`];
    const byCode = typeof codeValue === 'string' && codeValue.trim()
      ? resolveAirportByCode(codeValue)
      : null;
    const textCodes = findKnownAirportCodes(textValue);
    if (textCodes.length > 1 || (byCode && textCodes.some((code) => code !== byCode.code))) {
      conflictingSides.push(side);
    }
  }
  return conflictingSides;
}

/** Preserves trusted sides or removes unsafe sides before normalization. */
function preserveOrRemoveConflictingAirportSides(
  mergedDraft: Partial<HybridSearchFlightRequest>,
  previousDraft: Partial<HybridSearchFlightRequest> | undefined,
  sides: readonly ConflictingAirportSide[],
) {
  const next = { ...mergedDraft } as Record<string, unknown>;
  const previousConflicts = new Set(findConflictingAirportSides(previousDraft));
  for (const side of sides) {
    const codeKey = `${side}AirportCode` as const;
    const textKey = `${side}AirportText` as const;
    if (previousConflicts.has(side)) {
      delete next[codeKey];
      delete next[textKey];
    } else {
      next[codeKey] = previousDraft?.[codeKey];
      next[textKey] = previousDraft?.[textKey];
    }
  }
  return next as Partial<HybridSearchFlightRequest>;
}

/**
 * Resolves labels from the catalog and rejects a code/text conflict instead
 * of silently choosing one side of a contradictory model draft.
 */
function resolveCanonicalAirport(
  codeValue: unknown,
  textValue: unknown,
): ResolvedAirport | null {
  const byCode = typeof codeValue === 'string' && codeValue.trim()
    ? resolveAirportByCode(codeValue)
    : null;
  const textCodes = findKnownAirportCodes(textValue);
  const byText = textCodes.length === 1
    ? resolveAirportByCode(textCodes[0])
    : null;
  if (textCodes.length > 1 || (byCode && byText && byCode.code !== byText.code)) return null;
  return byCode ?? byText;
}

/** Asks for only the unresolved route side and uses catalog-owned labels. */
function renderRouteClarification(
  route: ReturnType<typeof resolveCanonicalRoute>,
  conflictingSides: readonly ConflictingAirportSide[] = [],
) {
  const hasFromConflict = conflictingSides.includes('from');
  const hasToConflict = conflictingSides.includes('to');
  if (hasFromConflict && hasToConflict) {
    return 'Bạn xác nhận lại điểm đi và điểm đến giúp mình nhé.';
  }
  if (hasFromConflict) {
    return route.to
      ? `Bạn xác nhận điểm đi nhé. Điểm đến hiện là ${route.to.text}.`
      : 'Bạn xác nhận điểm đi giúp mình nhé.';
  }
  if (hasToConflict) {
    return route.from
      ? `Bạn xác nhận điểm đến nhé. Điểm đi hiện là ${route.from.text}.`
      : 'Bạn xác nhận điểm đến giúp mình nhé.';
  }
  if (!route.from && !route.to) {
    return 'Bạn cho mình biết điểm đi và điểm đến nhé.';
  }
  if (!route.from) {
    return `Bạn cho mình biết điểm đi nhé. Điểm đến hiện là ${route.to!.text}.`;
  }
  if (!route.to) {
    return `Bạn cho mình biết điểm đến nhé. Điểm đi hiện là ${route.from.text}.`;
  }
  return `Bạn xác nhận tuyến ${route.from.text} → ${route.to.text} nhé?`;
}

/** Adds a canonical route context to date/time/criterion questions only. */
function renderCanonicalRouteReference(route: ReturnType<typeof resolveCanonicalRoute>) {
  return `Tuyến hiện tại: ${route.from!.text} → ${route.to!.text}.`;
}

/** Allows a retained date into a greeting only after a calendar-shape check. */
function isUsableIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Formats a validated ISO date in the Vietnamese operator-facing style. */
function formatVietnameseDate(value: string) {
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

async function executeInspect(context: HybridSearchAgentContext) {
  if (!claimDecisionTool(context, 'inspect_case')) return context.outcome?.response ?? 'Lượt này đã xử lý một công cụ.';
  if (context.session.pendingClarification?.fields.length) {
    const response = formatProposalIssues(context.session.pendingClarification.fields.map(field => ({ field, reason: 'missing' })));
    context.outcome = { status: 'clarification', response };
    return response;
  }
  const snapshot = context.session.snapshot;
  if (!snapshot || !context.session.snapshotFresh) {
    const response = context.session.lastSearchError
      ? 'Mình chưa có kết quả tìm mới để xem lại. Bạn gửi lại yêu cầu tìm chuyến giúp mình nhé.'
      : 'Mình chưa có snapshot chuyến bay nào trong cuộc trò chuyện này.';
    context.outcome = { status: 'inspected', response };
    return response;
  }

  if (!acceptSearchProposal(context, { requestMode: 'update_search' }, true)) return context.outcome!.response;
  const inspectedRequest = validateHybridFlightRequest(toCompleteRequest(context.session.draftRequest ?? {}), {
    now: context.now, todayIso: context.todayIso,
  });
  if (!inspectedRequest.ok || !isSameFlightSearchRouteAndDate(snapshot, inspectedRequest.request)) {
    const response = 'Snapshot đang lưu không khớp yêu cầu hiện tại đã xác minh. Bạn tìm lại chuyến giúp mình nhé.';
    context.outcome = { status: 'invalid', response };
    return response;
  }
  let filtered: FlightSearchSnapshotFilterResult;
  try {
    filtered = filterFlightSearchSnapshot(snapshot, {
      limit: 5,
      criterion: context.session.lastCompareCriterion,
      resultRanking: context.session.lastCompareCriterion === 'cheapest'
        ? 'cheapest'
        : context.session.draftRequest?.resultRanking ?? undefined,
      preferredAirlineCodes: context.session.draftRequest?.preferredAirlineCodes,
      preferredTime: context.session.draftRequest?.preferredTime ?? undefined,
      specificTime: context.session.draftRequest?.specificTime,
      timeConstraint: toHybridTimeConstraint(context.session.draftRequest?.timeConstraint),
    }, { now: context.now, todayIso: context.todayIso });
  } catch {
    const response = 'Snapshot hiện tại không còn hợp lệ để đối chiếu. Bạn tìm lại chuyến giúp mình nhé.';
    context.outcome = { status: 'invalid', response };
    return response;
  }

  const response = formatSnapshotResponse(snapshot, filtered, 'đang lưu');
  context.outcome = {
    resultFilter: filtered,
    status: filtered.noMatches ? 'no_match' : 'inspected',
    response,
    snapshotId: snapshot.snapshotId,
    snapshot,
    screenshotBatches: screenshotsForSelected(snapshot, filtered.selectedCandidates),
    capturedAt: snapshot.capturedAt,
  };
  return response;
}

async function executeCompare(
  context: HybridSearchAgentContext,
  input: CompareInput,
) {
  if (!claimDecisionTool(context, 'compare_flights')) return context.outcome?.response ?? 'Lượt này đã xử lý một công cụ.';
  if (!acceptSearchProposal(context, input, true)) return context.outcome!.response;
  const snapshot = context.session.snapshot;
  if (!snapshot || !context.session.snapshotFresh) {
    const response = 'Mình chưa có snapshot mới để so sánh. Bạn yêu cầu tìm chuyến trước nhé.';
    context.outcome = { status: 'invalid', response };
    return response;
  }

  // A follow-up such as “sau 10h” may only contain the changed time field.
  // Merge it into the retained draft before filtering so earlier route/date,
  // airline and ranking criteria remain part of the comparison. Explicit
  // clearFields is the only way to remove a retained criterion.
  const effectiveInput = applyDeterministicTextTime(input, context.text);
  const rawMergedDraft = context.session.draftRequest ?? {};
  const rawValidation = validateHybridFlightRequest(toRawValidationRequest(rawMergedDraft), {
    rawText: context.text,
    now: context.now,
    todayIso: context.todayIso,
  });
  if (!rawValidation.ok && isHardValidationFailure(rawValidation.reason)) {
    context.outcome = {
      status: rawValidation.reason === 'unsupported_request' ? 'unsupported' : 'invalid',
      response: rawValidation.message,
      snapshotId: snapshot.snapshotId,
    };
    return rawValidation.message;
  }
  const mergedDraft = normalizeDraftForPersistence(
    rawMergedDraft,
    context.text,
    context.now,
    context.todayIso,
  );
  context.session.draftRequest = mergedDraft;
  const retainedRequest = toCompleteRequest(mergedDraft);
  const retainedValidation = validateHybridFlightRequest(retainedRequest, {
    rawText: context.text,
    now: context.now,
    todayIso: context.todayIso,
  });
  if (!retainedValidation.ok || !isSameFlightSearchRouteAndDate(snapshot, retainedValidation.request)) {
    const response = !retainedValidation.ok ? retainedValidation.message
      : 'Yêu cầu hiện tại khác tuyến hoặc ngày của snapshot. Cần tìm chuyến cho yêu cầu mới trước khi so sánh.';
    context.repairNeeded = retainedValidation.ok;
    context.outcome = { status: 'invalid', response };
    return response;
  }
  const compareNotices = retainedValidation.ok
    ? [retainedValidation.dateNotice, retainedValidation.timeNotice]
      .filter((notice): notice is string => Boolean(notice))
    : [];
  if (input.candidateIds && !input.snapshotId) {
    const response = 'Cần mã snapshot đi cùng mã chuyến. Bạn chọn theo danh sách mới nhất giúp mình nhé.';
    context.outcome = { status: 'invalid', response };
    return response;
  }
  if (input.candidateIds && snapshot.candidates.length > 30 && input.candidateIds.length < snapshot.candidates.length) {
    const response = 'Snapshot có hơn 30 chuyến nên mình cần so sánh toàn bộ danh sách đã xác minh. Bạn nói tiêu chí giá rẻ, sớm nhất hoặc muộn nhất nhé.';
    context.outcome = { status: 'invalid', response, snapshotId: snapshot.snapshotId };
    return response;
  }

  try {
    const criterion = effectiveInput.criterion ?? context.session.lastCompareCriterion;
    const filter = filterFlightSearchSnapshot(snapshot, {
      criterion,
      resultRanking: retainedRequest.resultRanking ?? undefined,
      preferredTime: retainedRequest.preferredTime ?? undefined,
      specificTime: retainedRequest.specificTime,
      timeConstraint: toHybridTimeConstraint(retainedRequest.timeConstraint),
      preferredAirlineCodes: retainedRequest.preferredAirlineCodes,
      candidateIds: effectiveInput.candidateIds,
      snapshotId: effectiveInput.snapshotId,
      limit: effectiveInput.limit ?? 5,
    }, { now: context.now, todayIso: context.todayIso });
    const response = formatSnapshotResponse(
      snapshot,
      filter,
      criterion ? `theo tiêu chí ${criterionLabel(criterion)}` : 'theo danh sách đã xác minh',
      compareNotices,
    );
    context.outcome = {
      resultFilter: filter,
      status: filter.noMatches ? 'no_match' : 'compared',
      response,
      snapshotId: snapshot.snapshotId,
      snapshot,
      screenshotBatches: screenshotsForSelected(snapshot, filter.selectedCandidates),
      capturedAt: snapshot.capturedAt,
    };
    return response;
  } catch (error) {
    const response = isBadCandidateIdError(error)
      ? 'Mã chuyến không thuộc snapshot hiện tại. Bạn chọn theo danh sách mới nhất giúp mình nhé.'
      : 'Tiêu chí so sánh chưa hợp lệ. Bạn nói giá rẻ nhất, sớm nhất hoặc muộn nhất nhé.';
    context.outcome = { status: 'invalid', response, snapshotId: snapshot.snapshotId };
    return response;
  }
}

async function executeSearch(
  context: HybridSearchAgentContext,
  input: RequestPatch,
) {
  if (!claimDecisionTool(context, 'search_flights')) return context.outcome?.response ?? 'Lượt này đã xử lý một công cụ.';
  if (!acceptSearchProposal(context, input)) return context.outcome!.response;
  const effectiveInput = applyDeterministicTextTime(input, context.text);
  const draft = context.session.draftRequest ?? {};
  const rawValidation = validateHybridFlightRequest(toRawValidationRequest(draft), {
    rawText: context.text,
    now: context.now,
    todayIso: context.todayIso,
  });
  if (!rawValidation.ok && isHardValidationFailure(rawValidation.reason)) {
    const status = rawValidation.reason === 'unsupported_request' ? 'unsupported' : 'invalid';
    context.outcome = { status, response: rawValidation.message };
    return rawValidation.message;
  }
  const normalizedDraft = normalizeDraftForPersistence(
    draft,
    context.text,
    context.now,
    context.todayIso,
  );
  context.session.draftRequest = normalizedDraft;

  const validation = validateHybridFlightRequest(toCompleteRequest(normalizedDraft), {
    rawText: context.text,
    now: context.now,
    todayIso: context.todayIso,
  });
  if (!validation.ok) {
    const status = validation.reason === 'unsupported_request' ? 'unsupported'
      : validation.reason === 'unknown_airline' ? 'invalid'
        : 'clarification';
    context.outcome = { status, response: validation.message };
    return validation.message;
  }

  const request = validation.request;
  context.session.draftRequest = request;
  const refresh = effectiveInput.refresh === true;
  const snapshot = context.session.snapshot;
  if (
    snapshot &&
    context.session.snapshotFresh &&
    !refresh &&
    isSameFlightSearchRouteAndDate(snapshot, request)
  ) {
    return executeCachedRequest(
      context,
      request,
      'searched',
      [validation.dateNotice, validation.timeNotice].filter((notice): notice is string => Boolean(notice)),
    );
  }

  if (context.liveSearchPerformed) {
    const response = 'Mình chỉ chạy một lượt tìm chuyến cho mỗi tin nhắn. Bạn gửi lại yêu cầu nếu muốn làm mới kết quả nhé.';
    context.outcome = { status: 'busy', response };
    return response;
  }

  const settings = await safelyReadSettings(context.settingsReader);
  if (!settings.agentEnabled) {
    const response = 'Agent hiện đang tắt. Mình chưa chạy tìm chuyến nhé.';
    context.outcome = { status: 'disabled', response };
    return response;
  }
  if (!settings.autoSearchFlights) {
    const response = 'autoSearchFlights đang tắt. Mình đã lưu yêu cầu nhưng chưa mở 1Booking nhé.';
    context.outcome = { status: 'disabled', response };
    return response;
  }

  const oldSnapshot = context.session.snapshot;
  let flightCase: Awaited<ReturnType<typeof createLocalFlightCase>> | undefined;
  try {
    flightCase = await createLocalFlightCase(context.text, context.chatId);
    context.session.lastAttemptCaseId = flightCase.caseId;
    const searchInput = toSearchFlightsInput(request);
    await updateLocalFlightCase(flightCase, {
      status: 'SEARCH_RUNNING',
      parsedRequest: request,
      searchInput,
    });

    context.liveSearchPerformed = true;
    const result = await context.automation(searchInput, {
      caseId: flightCase.caseId,
      fullSnapshot: true,
    });
    if (!result.ok || !result.snapshot) {
      const response = formatSearchFailure(result.ok ? undefined : result.message);
      contextFailureReason(context, result.ok ? 'search_empty_result' : result.message);
      await updateLocalFlightCase(flightCase, {
        status: 'SEARCH_FAILED',
        errorMessage: response,
        screenshotPath: result.ok ? undefined : result.errorScreenshotPath ?? undefined,
      });
      context.session.snapshotFresh = false;
      context.session.lastSearchError = response;
      if (!oldSnapshot) context.session.caseId = flightCase.caseId;
      context.outcome = {
        status: classifySearchFailureStatus(result.ok ? undefined : result.message),
        response,
        caseId: context.session.caseId ?? flightCase.caseId,
        snapshotId: oldSnapshot?.snapshotId,
        liveSearchPerformed: true,
        screenshotPaths: result.ok ? [] : result.errorScreenshotPath ? [result.errorScreenshotPath] : [],
      };
      return response;
    }

    if (!isSameFlightSearchRouteAndDate(result.snapshot, request)) {
      const response = '1Booking trả về tuyến hoặc ngày khác với yêu cầu đã xác minh. Mình chưa hiển thị kết quả này nhé.';
      await updateLocalFlightCase(flightCase, { status: 'SEARCH_FAILED', errorMessage: response });
      context.session.snapshotFresh = false;
      context.session.lastSearchError = response;
      context.outcome = { status: 'invalid', response, caseId: context.session.caseId ?? flightCase.caseId, liveSearchPerformed: true };
      return response;
    }

    const filter = filterFlightSearchSnapshot(
      result.snapshot,
      toSnapshotFilterRequest(request, context.session.lastCompareCriterion),
      {
      now: context.now,
      todayIso: context.todayIso,
      },
    );
    const screenshotPaths = result.screenshotPaths ?? result.snapshot.screenshots.map((item) => item.path);
    const screenshotBatches = screenshotsForSelected(result.snapshot, filter.selectedCandidates);
    const finalCase = await updateLocalFlightCase(flightCase, {
      status: 'SEARCH_DONE',
      parsedRequest: request,
      searchInput,
      flightCandidates: result.snapshot.candidates,
      hybridSearchSnapshot: result.snapshot,
      flightCount: result.flightCount,
      displayedFlightCount: filter.selectedCandidates.length,
      flightResultFilter: filter.summary,
      screenshotPath: result.screenshotPath ?? screenshotPaths[0],
      screenshotPaths,
    });
    context.session.snapshot = result.snapshot;
    context.session.snapshotFresh = true;
    context.session.snapshotId = result.snapshot.snapshotId;
    context.session.caseId = finalCase.caseId;
    context.session.lastAttemptCaseId = finalCase.caseId;
    context.session.lastSearchError = undefined;
    const response = formatSnapshotResponse(
      result.snapshot,
      filter,
      refresh ? 'sau khi làm mới' : 'sau khi tìm',
      [validation.dateNotice, validation.timeNotice].filter((notice): notice is string => Boolean(notice)),
    );
    context.outcome = {
      resultFilter: filter,
      status: filter.noMatches ? 'no_match' : 'searched',
      response,
      caseId: finalCase.caseId,
      snapshotId: result.snapshot.snapshotId,
      snapshot: result.snapshot,
      screenshotPaths: filter.selectedCandidates.length > 0 ? screenshotPaths : [],
      screenshotBatches,
      capturedAt: result.snapshot.capturedAt,
      liveSearchPerformed: true,
    };
    return response;
  } catch (error) {
    const response = formatSearchFailure(error instanceof Error ? error.message : undefined);
    contextFailureReason(context, error);
    if (flightCase) {
      await updateLocalFlightCase(flightCase, {
        status: 'SEARCH_FAILED',
        errorMessage: response,
      }).catch(() => undefined);
    }
    context.session.snapshotFresh = false;
    context.session.lastSearchError = response;
    context.outcome = {
      status: classifySearchFailureStatus(error instanceof Error ? error.message : undefined),
      response,
      caseId: context.session.caseId ?? flightCase?.caseId,
      snapshotId: oldSnapshot?.snapshotId,
      liveSearchPerformed: true,
    };
    return response;
  }
}

function executeCachedRequest(
  context: HybridSearchAgentContext,
  request: HybridSearchFlightRequest,
  status: 'searched' | 'compared',
  notices: string[] = [],
) {
  const snapshot = context.session.snapshot;
  if (!snapshot || !context.session.snapshotFresh) {
    const response = 'Mình chưa có snapshot mới để lọc. Bạn tìm chuyến trước nhé.';
    context.outcome = { status: 'invalid', response };
    return response;
  }
  try {
    const filter = filterFlightSearchSnapshot(
      snapshot,
      toSnapshotFilterRequest(request, context.session.lastCompareCriterion),
      {
      now: context.now,
      todayIso: context.todayIso,
      },
    );
    const response = formatSnapshotResponse(snapshot, filter, 'từ snapshot đã lưu', notices);
    context.outcome = {
      resultFilter: filter,
      status: filter.noMatches ? 'no_match' : status,
      response,
      caseId: context.session.caseId,
      snapshotId: snapshot.snapshotId,
      snapshot,
      screenshotBatches: screenshotsForSelected(snapshot, filter.selectedCandidates),
      capturedAt: snapshot.capturedAt,
      liveSearchPerformed: false,
    };
    return response;
  } catch {
    const response = 'Tiêu chí lọc chưa hợp lệ. Bạn gửi lại hãng bay hoặc thời gian rõ hơn nhé.';
    context.outcome = { status: 'invalid', response, snapshotId: snapshot.snapshotId };
    return response;
  }
}

/** Claim one tool execution per SDK decision, including multi-call provider responses. */
function claimDecisionTool(context: HybridSearchAgentContext, name: string) {
  if (context.decisionToolUsed || context.liveSearchPerformed) return false;
  context.decisionToolUsed = true;
  context.toolName = name;
  return true;
}

/** Validate proposals before any state transition, clarification, cache access or browser work. */
function acceptSearchProposal(context: HybridSearchAgentContext, patch: SearchProposal, comparison = false) {
  const stage1 = validateHybridFlightRequest(toRawValidationRequest(patch), {
    rawText: context.text, now: context.now, todayIso: context.todayIso,
  });
  if (!stage1.ok && stage1.reason === 'unsupported_request') {
    context.outcome = { status: 'unsupported', response: stage1.message };
    return false;
  }
  const checked = validateSearchProposal({
    patch, previous: context.session.draftRequest, pending: context.session.pendingClarification,
    text: context.text, comparison,
    todayIso: context.todayIso ?? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(context.now),
  });
  context.resolvedRequestMode = checked.mode;
  context.confirmedIntent = checked.confirmedIntent;
  context.proposalIssues = checked.issues;
  context.fieldResults = checked.results;
  context.validationAttempts = [...(context.validationAttempts ?? []), checked.results];
  if (!checked.issues.some(issue => issue.field === 'intent')) {
    context.session.draftRequest = checked.draft;
    if (checked.mode === 'new_search') context.session.lastCompareCriterion = undefined;
    if (!checked.issues.some(issue => issue.field === 'ranking') && checked.comparisonCriterion !== undefined) {
      context.session.lastCompareCriterion = checked.comparisonCriterion ?? undefined;
    }
  }
  if (checked.issues.some(issue => issue.field === 'intent')) {
    // Stage only current-message facts, never the prior route or optional filters.
    const staged = validateSearchProposal({
      patch: { ...patch, requestMode: 'new_search' }, text: context.text,
      todayIso: context.todayIso ?? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(context.now),
    });
    const currentFacts = Object.keys(staged.draft).some(key => key !== 'tripType' && key !== 'missingFields');
    const onlyIntentUnresolved = checked.issues.every(issue => issue.field === 'intent');
    context.intentDraftForTurn = currentFacts || !onlyIntentUnresolved
      ? { ...context.intentDraftForTurn, ...staged.draft }
      : context.intentDraftForTurn ?? context.session.pendingClarification?.intentDraft ?? staged.draft;
  }
  context.session.pendingClarification = checked.issues.length
    ? { fields: [...new Set(checked.issues.map(issue => issue.field))],
      ...(checked.issues.some(issue => issue.field === 'intent') ? { intentDraft: context.intentDraftForTurn } : {}) }
    : undefined;
  const retained = context.session.snapshot;
  if (retained && (retained.route.fromAirportCode !== context.session.draftRequest?.fromAirportCode
    || retained.route.toAirportCode !== context.session.draftRequest?.toAirportCode
    || retained.departureDate !== context.session.draftRequest?.departureDate
    || checked.issues.some(issue => ['intent', 'fromAirport', 'toAirport', 'departureDate'].includes(issue.field)))) {
    context.session.snapshotFresh = false;
  }
  if (checked.issues.length) {
    context.repairNeeded = checked.repairable;
    context.outcome = { status: 'clarification', response: formatProposalIssues(checked.issues) };
    return false;
  }
  return true;
}

function mergeHybridRequestDraft(
  previous: Partial<HybridSearchFlightRequest> | undefined,
  patch: Partial<RequestPatch>,
  explicitClearFields?: string[],
) {
  const result: Record<string, unknown> = { ...(previous ?? {}) };
  const clearFields = new Set(explicitClearFields ?? []);
  const keys = [
    'fromAirportCode', 'fromAirportText', 'toAirportCode', 'toAirportText',
    'departureDate', 'returnDate', 'preferredTime', 'specificTime',
    'resultRanking', 'preferredAirlineCodes', 'tripType', 'missingFields',
    'timeConstraint',
  ] as const;
  for (const key of keys) {
    if (clearFields.has(key)) {
      result[key] = null;
      continue;
    }
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) continue;
    // Models commonly emit null for omitted optional criteria. Preserve the
    // retained draft unless the model explicitly names a field to clear.
    if (value === null && result[key] !== undefined) continue;
    result[key] = value;
  }
  if (clearFields.has('refresh')) result.refresh = undefined;
  return result as Partial<HybridSearchFlightRequest>;
}

/**
 * The model may describe a Vietnamese time phrase with a weaker or broader
 * operator. The stage1 parser already owns the approved deterministic time
 * grammar, so use its unambiguous result at the tool boundary while leaving
 * unsupported/vague wording to the model's clarification tool.
 */
function applyDeterministicTextTime<T extends {
  preferredTime?: RequestPatch['preferredTime'];
  specificTime?: string | null;
  timeConstraint?: RequestPatch['timeConstraint'];
  clearFields?: string[];
}>(input: T, rawText: string): T {
  if (input.clearFields?.some((field) =>
    field === 'preferredTime' || field === 'specificTime' || field === 'timeConstraint')) {
    return input;
  }
  const constraint = parseHybridTimeConstraintFromVietnameseText(rawText);
  if (!constraint) return input;
  return {
    ...input,
    preferredTime: constraint.kind === 'between' ? input.preferredTime : 'specific_time',
    specificTime: constraint.exactTime,
    timeConstraint: constraint,
  } as T;
}

function normalizeDraftForPersistence(
  draft: Partial<HybridSearchFlightRequest>,
  rawText: string,
  now: Date,
  todayIso?: string,
) {
  const complete = toCompleteRequest(draft);
  let normalized = normalizeHybridRequest(complete, rawText);
  const dateResult = resolveHybridDepartureDate(
    normalized.departureDate,
    rawText,
    todayIso ?? getVietnamTodayIso(now),
  );
  if (dateResult.ok) normalized = { ...normalized, departureDate: dateResult.departureDate };
  const constraint = normalized.timeConstraint ?? parseHybridTimeConstraintFromVietnameseText(rawText);
  if (constraint) {
    normalized = {
      ...normalized,
      timeConstraint: constraint,
      preferredTime: constraint.kind === 'between' ? normalized.preferredTime : 'specific_time',
      specificTime: constraint.exactTime ?? normalized.specificTime,
    };
  }
  return removeDraftDefaults(normalized);
}

function removeDraftDefaults(request: HybridSearchFlightRequest) {
  const result: Partial<HybridSearchFlightRequest> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key === 'missingFields') continue;
    if (value === undefined) continue;
    // Nullable fields are retained when explicit so future validators receive
    // a complete object; route/date callers still get a useful partial draft.
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

function toCompleteRequest(request: Partial<HybridSearchFlightRequest>): HybridSearchFlightRequest {
  return {
    fromAirportCode: request.fromAirportCode ?? null,
    fromAirportText: request.fromAirportText ?? null,
    toAirportCode: request.toAirportCode ?? null,
    toAirportText: request.toAirportText ?? null,
    departureDate: request.departureDate ?? null,
    returnDate: request.returnDate ?? null,
    preferredTime: request.preferredTime ?? null,
    specificTime: request.specificTime ?? null,
    resultRanking: request.resultRanking ?? null,
    preferredAirlineCodes: request.preferredAirlineCodes ?? null,
    tripType: request.tripType ?? 'one_way',
    missingFields: request.missingFields ?? [],
    timeConstraint: toHybridTimeConstraint(request.timeConstraint),
  };
}

/** Preserve an untrusted model time object until stage1 can reject it. */
function toRawValidationRequest(request: Partial<HybridSearchFlightRequest>): unknown {
  const complete = toCompleteRequest(request) as unknown as Record<string, unknown>;
  return {
    ...complete,
    timeConstraint: request.timeConstraint === undefined ? null : request.timeConstraint,
  };
}

/** Converts the nullable SDK schema flags into the stricter application type. */
function toHybridTimeConstraint(value: unknown): HybridTimeConstraint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== 'string') return null;
  const allowedKinds = new Set(['around', 'exact', 'from', 'before', 'after', 'between']);
  if (!allowedKinds.has(raw.kind)) return null;
  return {
    kind: raw.kind as HybridTimeConstraint['kind'],
    startTime: typeof raw.startTime === 'string' ? raw.startTime : null,
    endTime: typeof raw.endTime === 'string' ? raw.endTime : null,
    exactTime: typeof raw.exactTime === 'string' ? raw.exactTime : null,
    startInclusive: raw.startInclusive !== false,
    endInclusive: raw.endInclusive !== false,
  };
}

function toSearchFlightsInput(request: HybridSearchFlightRequest): SearchFlightsInput {
  return {
    fromAirportCode: request.fromAirportCode,
    fromAirportText: request.fromAirportText,
    toAirportCode: request.toAirportCode,
    toAirportText: request.toAirportText,
    departureDate: request.departureDate,
    preferredTime: request.preferredTime,
    specificTime: request.specificTime,
    timeConstraint: toHybridTimeConstraint(request.timeConstraint),
    resultRanking: request.resultRanking ?? undefined,
    resultLimit: 5,
    preferredAirlineCodes: request.preferredAirlineCodes,
  };
}

function toSnapshotFilterRequest(
  request: HybridSearchFlightRequest,
  criterion?: 'cheapest' | 'earliest' | 'latest',
) {
  return {
    criterion,
    preferredTime: request.preferredTime ?? undefined,
    specificTime: request.specificTime,
    timeConstraint: toHybridTimeConstraint(request.timeConstraint),
    preferredAirlineCodes: request.preferredAirlineCodes,
    resultRanking: request.resultRanking ?? undefined,
    limit: 5,
  } as const;
}

function formatSnapshotResponse(
  snapshot: FlightSearchSnapshot,
  filter: FlightSearchSnapshotFilterResult,
  reason: string,
  notices: string[] = [],
) {
  if (filter.noMatches) {
    return [
      `Mình không thấy chuyến nào khớp tiêu chí ${reason} trên snapshot ${snapshot.snapshotId}. Bạn thử nới thời gian hoặc đổi hãng bay nhé.`,
      ...notices,
    ].join('\n');
  }
  const route = `${snapshot.route.fromAirportCode} → ${snapshot.route.toAirportCode}`;
  if (filter.unrankable) {
    return [
      `Mình thấy ${filter.summary.matchedCount} chuyến cho ${route} ngày ${snapshot.departureDate} ${reason}, nhưng các chuyến này chưa có giá hiển thị để xếp “rẻ nhất”.`,
      'Mình chưa chọn đại một chuyến. Bạn thử tiêu chí giờ bay hoặc bỏ tiêu chí giá giúp mình nhé.',
      ...notices,
      `Snapshot xác minh lúc ${formatCapturedAt(snapshot.capturedAt)}.`,
    ].join('\n');
  }
  const exactImages = screenshotsForSelected(snapshot, filter.selectedCandidates);
  const imageNotice = filter.selectedCandidates.length > 0 && exactImages.length === 0
    ? 'Ảnh đã lưu chưa tách riêng các chuyến này. Bạn có thể nhắn “làm mới kết quả” để lấy ảnh đúng danh sách; mình vẫn giữ tuyến, ngày và bộ lọc hiện tại.'
    : undefined;
  const lines = filter.selectedCandidates.map((candidate, index) =>
    `${filter.offset + index + 1}. ${formatCandidate(candidate)}`,
  );
  const summary = filter.summary.priceRangeText
    ? `Khoảng giá trên trang này: ${filter.summary.priceRangeText}.`
    : 'Các chuyến chưa có giá hiển thị để so sánh.';
  return [
    `Mình tìm được ${filter.summary.matchedCount} chuyến cho ${route} ngày ${snapshot.departureDate} ${reason}.`,
    `Đang hiển thị chuyến ${filter.offset + 1}–${filter.offset + filter.selectedCandidates.length}/${filter.rankedCandidateIds.length}.`,
    ...(filter.rankedCandidateIds.length < filter.summary.matchedCount
      ? ['Các chuyến chưa có giá hiển thị không được xếp hạng theo giá.'] : []),
    ...lines,
    summary,
    ...(imageNotice ? [imageNotice] : []),
    ...notices,
    `Snapshot xác minh lúc ${formatCapturedAt(snapshot.capturedAt)}; mình chỉ hiển thị dữ liệu đã lưu từ 1Booking.`,
  ].join('\n');
}

function formatCandidate(candidate: FlightSearchSnapshotCandidate) {
  const price = candidate.priceText?.trim() || (
    candidate.priceAmount === null || candidate.priceAmount === undefined
      ? 'chưa có giá hiển thị'
      : `${new Intl.NumberFormat('vi-VN').format(candidate.priceAmount)} VND`
  );
  return `${candidate.flightNumber} · ${candidate.airlineName} · ${candidate.departureTime}-${candidate.arrivalTime} · ${price}`;
}

function screenshotsForSelected(
  snapshot: FlightSearchSnapshot,
  candidates: FlightSearchSnapshotCandidate[],
) {
  return screenshotsForFlightSearchResult(
    snapshot,
    candidates.map((candidate) => candidate.candidateId),
  ).map((batch) => ({ path: batch.path, candidateIds: batch.candidateIds.slice() }));
}

export function buildHybridInstructions(
  context: HybridSearchAgentContext,
  buildOptions: HybridSearchAgentBuildOptions = {},
) {
  const snapshot = context.session.snapshot;
  const candidateProjection = snapshot?.candidates.slice(0, MAX_MODEL_CANDIDATES).map((candidate) => ({
    candidateId: candidate.candidateId,
    cardIndex: candidate.cardIndex,
    airlineCode: candidate.airlineCode,
    airlineName: candidate.airlineName,
    flightNumber: candidate.flightNumber,
    departureTime: candidate.departureTime,
    arrivalTime: candidate.arrivalTime,
    priceText: candidate.priceText,
    priceAmount: candidate.priceAmount,
  }));
  const airportCatalog = HYBRID_AIRPORT_CATALOG.map((airport) => ({
    code: airport.code,
    text: airport.text,
    aliases: airport.aliases,
  }));
  return [
    'Bạn là agent tìm chuyến bay bằng tiếng Việt cho operator nội bộ.',
    'Mỗi lượt chỉ gọi đúng một tool trong bốn tool được cấp: ask_operator_for_clarification, inspect_case, search_flights, compare_flights.',
    'Không gọi, đề xuất hoặc mô phỏng chọn chuyến, lấy thông tin hành khách, giữ chỗ, PNR, thanh toán hay công cụ legacy.',
    'Không bịa mã sân bay, mã hãng, ngày, giá, số hiệu, giờ bay, caseId hoặc snapshotId. Mọi dữ liệu chuyến phải lấy từ tool output.',
    `Danh mục sân bay chính thức là nguồn duy nhất để hiểu điểm đi/điểm đến và mã IATA. Chỉ dùng mã, tên hiển thị và alias trong danh mục này, rồi gửi mã cùng tên canonical vào tool: ${JSON.stringify(airportCatalog)}`,
    'Khi gọi ask_operator_for_clarification, bắt buộc gửi purpose là greeting, help, clarify hoặc unsupported và target là route, date, time, threshold, ranking hoặc none. Chỉ gửi purpose, target và draftRequest khi có dữ kiện; question là trường cũ tùy chọn, ứng dụng bỏ qua nó và tự dựng câu customer, nên không đưa tên/mã sân bay, ngày, giá, chuyến hoặc PNR vào question. Không trả lời bằng văn bản tự do ngoài tool.',
    'Nếu operator chỉ chào hỏi (ví dụ “xin chào”), gọi ask_operator_for_clarification với purpose=greeting,target=none. Nếu operator hỏi cách dùng/trợ giúp, dùng purpose=help,target=none. Ứng dụng sẽ giữ route/date đã xác minh khi greeting và bỏ qua mọi draftRequest đi kèm greeting/help.',
    ...(buildOptions.protocolRecovery ? [
      'Protocol recovery: lượt trước không gọi tool. Với đúng tin nhắn hiện tại, bắt buộc gọi đúng một trong bốn tool được cấp. Nếu đã đủ tuyến/ngày thì dùng search_flights hoặc compare_flights theo snapshot; nếu còn thiếu thì dùng ask_operator_for_clarification với purpose=clarify; chào hỏi dùng purpose=greeting, trợ giúp dùng purpose=help. Tuyệt đối không trả về câu trả lời văn bản tự do.',
    ] : []),
    'Khi operator nói “tốt nhất”, “giờ đẹp”, “đừng quá sớm” mà chưa có tiêu chí đo được, hỏi lại ngưỡng hoặc tiêu chí tự nhiên bằng tiếng Việt.',
    'Nếu operator yêu cầu giữ chỗ, chọn chuyến, nhập hành khách, PNR hoặc bất kỳ thao tác booking nào, bắt buộc gọi ask_operator_for_clarification với purpose=unsupported, reason=unsupported_request,target=none và nói rõ pilot chỉ tìm/so sánh; tuyệt đối không gọi inspect_case, compare_flights hoặc search_flights để thay thế.',
    'Giờ Việt Nam hiện tại: ' + formatVietnamNow(context.now) + '. Ngày yearless được hiểu là lần xuất hiện kế tiếp từ ngày hôm nay; không tìm ngày đã qua.',
    'Dùng timeConstraint around cho “gần/khoảng HH:mm” và câu tự nhiên “bay HHh/đổi giờ bay HHh” với cửa sổ ±2 giờ (kẹp trong ngày); exact chỉ cho “đúng HH:mm”; from là >=, before là <, after là >, between là khoảng hai đầu mút. Không hỏi lại khi câu chỉ nói bay HHh.',
    'Nếu yêu cầu là hôm nay mà chưa có mốc giờ sớm nhất, gọi ask_operator_for_clarification; không tự chọn giờ chờ.',
    'Pilot chỉ hỗ trợ tìm một chiều. Nếu yêu cầu vòng về, điểm dừng, hành lý hoặc thời lượng, nói rõ giới hạn bằng tiếng Việt và không gọi search.',
    'Trong search_flights, compare_flights và draftRequest của clarification, gửi requestMode=new_search cho yêu cầu tìm mới hoặc update_search cho câu tiếp nối. Nếu chưa rõ, dùng unsure để hỏi khách. Tìm mới không kế thừa hãng/giờ/ưu tiên cũ; cập nhật chỉ đổi trường được nói đến.',
    'Gửi evidence cho các trường mới/đổi: fromAirport, toAirport, departureDate, time, airlines, ranking, tripType, clearFields, intent và refresh. Mỗi evidence là đoạn ngắn nguyên văn trong tin nhắn HIỆN TẠI, không phải giải thích hoặc nội dung lịch sử. Không biến dữ kiện cũ thành evidence mới. Thiếu code nhưng có tên thì gửi tên để code resolve catalog.',
    'Không hỏi lại điểm đi/đến hoặc ngày nếu tin nhắn đã nói rõ; điền đầy đủ proposal và dùng search_flights khi đủ dữ kiện. Câu trả lời một địa điểm chỉ bổ sung phía đang chờ. Không tự đảo vai trò đi/đến.',
    'Giữ nguyên các trường đã có trong draftRequest khi operator chỉ trả lời một phần. Muốn xoá một tiêu chí, dùng clearFields cùng evidence.clearFields rõ ràng.',
    'Khi khách trả lời tìm chuyến mới hoặc cập nhật cho câu hỏi intent đang chờ, dùng intentDraft đã xác minh trong pendingClarification; không xoá dữ kiện khách vừa nêu và không trình bày evidence cũ thành evidence mới. Câu nêu rõ tuyến và ngày của lần tìm mới không cần hỏi lại intent.',
    'Pending clarification: ' + JSON.stringify(context.session.pendingClarification ?? null),
    ...(buildOptions.proposalRecovery ? [
      'Đọc lại một lần: đề xuất trước chưa qua kiểm tra hoặc hỏi lại thông tin đã có. Chưa có browser nào chạy. Chỉ sửa theo tin nhắn hiện tại và draft đã kiểm tra; không đoán. Nếu vẫn thiếu dữ kiện thật, hỏi đúng phần đó.',
      'Field validation: ' + JSON.stringify(context.proposalIssues ?? []),
    ] : []),
    'Same route/date with a fresh snapshot must use compare_flights or search_flights as a cached filter. Use refresh=true only when the operator explicitly asks for a new live search.',
    'For a snapshot with more than 30 candidates, compare the complete verified snapshot and omit candidateIds.',
    `Current user request: ${JSON.stringify(redactAgentMessage(context.text, false))}`,
    `Trusted normalized draft: ${JSON.stringify(context.session.draftRequest ?? null)}`,
    `Trusted snapshot metadata: ${JSON.stringify(snapshot ? {
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      route: snapshot.route,
      departureDate: snapshot.departureDate,
      snapshotFresh: context.session.snapshotFresh,
      candidateCount: snapshot.candidates.length,
      candidates: candidateProjection,
    } : null)}`,
  ].join('\n');
}

function createTurnResult(
  status: HybridSearchTurnStatus,
  response: string,
  extra: Partial<HybridSearchTurnResult> = {},
): HybridSearchTurnResult {
  const {
    screenshotPaths,
    screenshotBatches,
    ...otherExtra
  } = extra;
  return {
    ok: ['clarification', 'inspected', 'compared', 'searched'].includes(status),
    status,
    response,
    message: response,
    liveSearchPerformed: false,
    ...otherExtra,
    // Keep the transport shape total when an outcome omits optional arrays.
    screenshotPaths: Array.isArray(screenshotPaths) ? screenshotPaths : [],
    screenshotBatches: Array.isArray(screenshotBatches) ? screenshotBatches : [],
  };
}

function appendHistory(history: HybridSearchChatMessage[], item: HybridSearchChatMessage) {
  return [...history, item].slice(-MAX_HISTORY_ITEMS);
}

async function safelyReadSettings(reader: HybridSearchSettingsReader) {
  try {
    return await reader();
  } catch {
    return {
      agentEnabled: false,
      autoSearchFlights: false,
      autoHoldBooking: false,
      requireConfirmationBeforeHold: true,
      debugMode: false,
    } satisfies AgentSettings;
  }
}

function classifySearchFailureStatus(message?: string): HybridSearchTurnStatus {
  if (!message) return 'error';
  if (/busy|lock|đang có|gián đoạn/i.test(message)) return 'busy';
  // Parser/browser failures must remain errors so operators do not mistake a
  // broken observation for a verified empty result. A settled successful
  // snapshot with zero matches is classified separately by the filter path.
  if (/no flight cards? parsed|parse(?:r|d)?\s*(?:0|zero)|selector|browser/i.test(message)) return 'error';
  if (/no match|no matching flights?|empty result|không thấy chuyến|không có chuyến phù hợp/i.test(message)) return 'no_match';
  if (/unsupported|round|hành lý|điểm dừng/i.test(message)) return 'unsupported';
  return 'error';
}

function isHardValidationFailure(
  reason: 'missing_fields' | 'invalid_date' | 'past_date' | 'today_needs_cutoff' | 'ambiguous_time' | 'unsupported_request' | 'unknown_airline',
) {
  return reason === 'invalid_date'
    || reason === 'past_date'
    || reason === 'ambiguous_time'
    || reason === 'unsupported_request'
    || reason === 'unknown_airline';
}

function formatSearchFailure(_message?: string) {
  return 'Mình chưa hoàn tất lượt tìm chuyến này. Bạn thử lại sau hoặc kiểm tra tuyến và ngày bay giúp mình nhé.';
}

function classifyModelFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/429|rate[ _-]?limit|too many requests|quota/i.test(message)) {
    return 'Dịch vụ AI đang giới hạn lượt xử lý. Bạn thử lại sau nhé.';
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return 'Mình chưa nhận được phản hồi của pilot trong thời gian cho phép. Bạn gửi lại yêu cầu khi sẵn sàng nhé.';
  }
  return 'Mình chưa thể xử lý yêu cầu tìm chuyến lúc này. Bạn thử gửi lại tuyến, ngày bay và tiêu chí giúp mình nhé.';
}

function criterionLabel(value: 'cheapest' | 'earliest' | 'latest') {
  if (value === 'cheapest') return 'giá hiển thị thấp nhất';
  if (value === 'earliest') return 'giờ khởi hành sớm nhất';
  return 'giờ khởi hành muộn nhất';
}

function formatCapturedAt(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(parsed);
}

function formatVietnamNow(value: Date) {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(value);
}

function isBadCandidateIdError(error: unknown) {
  return error instanceof Error && /Candidate ID|snapshot/i.test(error.message);
}

function sanitizeUsage(usage: { requests?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined) {
  if (!usage) return undefined;
  return {
    requests: finiteNonnegative(usage.requests),
    inputTokens: finiteNonnegative(usage.inputTokens),
    outputTokens: finiteNonnegative(usage.outputTokens),
    totalTokens: finiteNonnegative(usage.totalTokens),
  };
}

function addUsage(
  first: HybridSearchLogEntry['usage'],
  second: HybridSearchLogEntry['usage'],
): HybridSearchLogEntry['usage'] {
  if (!first) return second;
  if (!second) return first;
  return {
    requests: first.requests + second.requests,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    totalTokens: first.totalTokens + second.totalTokens,
  };
}

function finiteNonnegative(value: number | undefined) {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : 0;
}

/** Validates timeout values before they reach the SDK or abort timer. */
function validateModelTimeout(value: number, name: string) {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive finite number of milliseconds.`);
  }
  return Math.floor(value);
}

async function safeLog(
  logger: HybridSearchAgentOptions['logger'],
  entry: HybridSearchLogEntry,
) {
  try {
    if (logger) await logger(entry);
    else await appendLocalLog({
      level: entry.success ? 'info' : 'warn',
      event: 'hybrid_search_tool_invocation',
      caseId: entry.caseId,
      message: `${entry.toolName}: ${entry.outcomeStatus ?? (entry.success ? 'completed' : 'failed')}.`,
      meta: {
        turnId: entry.turnId,
        outcomeStatus: entry.outcomeStatus,
        resolvedRequestMode: entry.resolvedRequestMode,
        confirmedIntent: entry.confirmedIntent,
        repairAttempts: entry.repairAttempts,
        liveSearchPerformed: entry.liveSearchPerformed,
        validation: entry.validation,
        validationAttempts: entry.validationAttempts,
        mode: entry.mode,
        toolName: entry.toolName,
        modelName: entry.modelName,
        success: entry.success,
        latencyMs: entry.latencyMs,
        snapshotId: entry.snapshotId,
        usage: entry.usage,
        failureReason: entry.failureReason,
      },
    });
  } catch {
    // Logging must never trigger a retry or alter the customer response.
  }
}

function sanitizeInternalFailure(error: unknown) {
  if (!(error instanceof Error)) return 'unknown_error';
  const message = sanitizeAIError(error)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
  return `${error.name || 'Error'}: ${message}`;
}

function contextFailureReason(context: HybridSearchAgentContext, error: unknown) {
  context.failureReason = typeof error === 'string'
    ? sanitizeAIError(error).replace(/\s+/g, ' ').slice(0, 240)
    : sanitizeInternalFailure(error);
}

function getVietnamTodayIso(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Adds an application-level timeout to injected models while preserving aborts. */
function createBoundedModel(inner: Model, timeoutMs: number): Model {
  return {
    supportsPromptModelSelection: inner.supportsPromptModelSelection,
    async getResponse(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Hybrid model timeout.')), timeoutMs);
      const removeParentAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', removeParentAbort, { once: true });
      try {
        return await inner.getResponse({ ...request, signal: combineSignals(request.signal, controller.signal) });
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', removeParentAbort);
      }
    },
    async *getStreamedResponse(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Hybrid model timeout.')), timeoutMs);
      const removeParentAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', removeParentAbort, { once: true });
      try {
        yield* inner.getStreamedResponse({ ...request, signal: combineSignals(request.signal, controller.signal) });
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', removeParentAbort);
      }
    },
  };
}

function combineSignals(parent: AbortSignal | undefined, timeout: AbortSignal) {
  if (!parent) return timeout;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  if (parent.aborted) abort(parent);
  else parent.addEventListener('abort', () => abort(parent), { once: true });
  if (timeout.aborted) abort(timeout);
  else timeout.addEventListener('abort', () => abort(timeout), { once: true });
  return controller.signal;
}
