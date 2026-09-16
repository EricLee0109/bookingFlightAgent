import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FlightSearchSnapshot } from '../automation/1booking/flight-search-snapshot';
import {
  HybridTimeConstraintSchema,
  type HybridSearchFlightRequest,
} from '../agent/hybrid-flight-request';
import { z } from 'zod';
import { PROPOSAL_FIELDS, type PendingSearchClarification } from '../agent/hybrid-search-proposal';

const StoredDraftRequestSchema = z.object({
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
}).strict();

const StoredSnapshotCandidateSchema = z.object({
  candidateId: z.string().min(1).max(160),
  cardIndex: z.number().int().nonnegative(),
  airlineCode: z.string().min(1),
  airlineName: z.string().min(1),
  flightNumber: z.string().min(1),
  departureTime: z.string().regex(/^\d{2}:\d{2}$/),
  arrivalTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  bookingClass: z.enum(['ECO', 'DLX', 'SGB', 'SBB']).nullable(),
  rawBookingClassCode: z.string().nullable(),
  priceText: z.string().nullable(),
  priceAmount: z.number().finite().nonnegative().nullable(),
}).strict();

const StoredResultViewSchema = z.object({
  token: z.string().uuid(),
  snapshotId: z.string().min(1),
  candidateIds: z.array(z.string().min(1)).min(1),
  requestKey: z.string().length(64),
  pageSize: z.number().int().min(1).max(30),
}).strict();

/** The small conversation record owned by the hybrid-search pilot. */
export type HybridSearchChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type HybridSearchSession = {
  version: 1;
  chatId: number;
  ownerTelegramUserId?: number;
  history: HybridSearchChatMessage[];
  /** The latest normalized or partially normalized request draft. */
  draftRequest?: Partial<HybridSearchFlightRequest>;
  /** Unresolved fields block using retained values until new evidence arrives. */
  pendingClarification?: PendingSearchClarification;
  /** The last browser observation. It is not usable when snapshotFresh is false. */
  snapshot?: FlightSearchSnapshot;
  snapshotFresh: boolean;
  snapshotId?: string;
  caseId?: string;
  /** A failed refresh gets its own case, while the previous snapshot stays inspectable. */
  lastAttemptCaseId?: string;
  /** Last deterministic comparison criterion, retained for a later inspect turn. */
  lastCompareCriterion?: 'cheapest' | 'earliest' | 'latest';
  lastSearchError?: string;
  /** Latest paged result, invalidated when the request or snapshot changes. */
  resultView?: z.infer<typeof StoredResultViewSchema>;
  processedMessageIds: string[];
  updatedAt: string;
};

export type HybridSearchSessionStoreLike = {
  read(chatId: number): Promise<HybridSearchSession | null>;
  write(chatId: number, session: HybridSearchSession): Promise<void>;
  runExclusive?<T>(chatId: number, callback: () => Promise<T>): Promise<T>;
};

/**
 * File-backed per-chat state for the pilot.
 *
 * The chat id is hashed before becoming a filename, writes are atomic, and all
 * in-process work for one chat is serialized. The store intentionally keeps
 * user and assistant text bounded because it is application state rather than
 * an unbounded transcript archive.
 */
export class HybridSearchSessionStore implements HybridSearchSessionStoreLike {
  private static readonly queues = new Map<number, Promise<unknown>>();

  constructor(
    private readonly directory = path.resolve('data/hybrid-search-sessions'),
  ) {}

  async read(chatId: number): Promise<HybridSearchSession | null> {
    try {
      const raw = await fs.readFile(this.filePath(chatId), 'utf8');
      return normalizeStoredSession(JSON.parse(raw), chatId);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async write(chatId: number, session: HybridSearchSession) {
    const normalized = normalizeStoredSession(session, chatId);
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.filePath(chatId);
    const temporary = `${target}.${randomUUID()}.tmp`;

    try {
      await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`);
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Serializes model/search/cached-filter turns for a Telegram chat. */
  async runExclusive<T>(chatId: number, callback: () => Promise<T>): Promise<T> {
    const previous = HybridSearchSessionStore.queues.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(callback);
    HybridSearchSessionStore.queues.set(chatId, current);

    try {
      return await current;
    } finally {
      if (HybridSearchSessionStore.queues.get(chatId) === current) {
        HybridSearchSessionStore.queues.delete(chatId);
      }
    }
  }

  /** Creates a complete session object without touching disk. */
  create(chatId: number, ownerTelegramUserId?: number): HybridSearchSession {
    return {
      version: 1,
      chatId,
      ownerTelegramUserId,
      history: [],
      snapshotFresh: false,
      processedMessageIds: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Claims a Telegram message id under the caller's per-chat lock.
   * Returns false for a replay and never evicts the current id before writing.
   */
  async claimMessageId(
    chatId: number,
    messageId: number | string,
    ownerTelegramUserId?: number,
  ): Promise<boolean> {
    return this.runExclusive(chatId, async () => {
      const session = (await this.read(chatId)) ?? this.create(chatId, ownerTelegramUserId);
      assertSessionOwner(session, ownerTelegramUserId);
      const normalizedId = String(messageId);
      if (session.processedMessageIds.includes(normalizedId)) return false;
      session.processedMessageIds = [...session.processedMessageIds, normalizedId];
      session.updatedAt = new Date().toISOString();
      await this.write(chatId, session);
      return true;
    });
  }

  /** Records the first operator as audit metadata for this chat. */
  async ensureOwner(chatId: number, ownerTelegramUserId: number) {
    return this.runExclusive(chatId, async () => {
      const session = (await this.read(chatId)) ?? this.create(chatId, ownerTelegramUserId);
      assertSessionOwner(session, ownerTelegramUserId);
      if (session.ownerTelegramUserId === undefined) {
        session.ownerTelegramUserId = ownerTelegramUserId;
        session.updatedAt = new Date().toISOString();
        await this.write(chatId, session);
      }
      return session;
    });
  }

  async clear(chatId: number) {
    try {
      await fs.rm(this.filePath(chatId), { force: true });
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  private filePath(chatId: number) {
    const safeChatId = createHash('sha256')
      .update(String(chatId))
      .digest('hex');
    return path.join(this.directory, `${safeChatId}.json`);
  }
}

export function createEmptyHybridSearchSession(
  chatId: number,
  ownerTelegramUserId?: number,
): HybridSearchSession {
  return {
    version: 1,
    chatId,
    ownerTelegramUserId,
    history: [],
    snapshotFresh: false,
    processedMessageIds: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Kept public for test stores and transport adapters. */
export function assertHybridSearchSessionOwner(
  session: HybridSearchSession,
  ownerTelegramUserId?: number,
) {
  assertSessionOwner(session, ownerTelegramUserId);
}

function assertSessionOwner(
  session: HybridSearchSession,
  ownerTelegramUserId?: number,
) {
  // The transport allowlist authorizes operators. A Telegram group chat is
  // intentionally chat-scoped, so two allowed operators may continue the same
  // conversation. Keep the first owner as audit metadata only.
  void session;
  void ownerTelegramUserId;
}

function normalizeStoredSession(value: unknown, chatId: number): HybridSearchSession {
  if (!value || typeof value !== 'object') {
    throw new Error('Hybrid search session is malformed.');
  }

  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error('Hybrid search session version is unsupported.');
  }
  if (raw.chatId !== chatId) {
    throw new Error('Hybrid search session belongs to a different Telegram chat.');
  }
  if (raw.history !== undefined && !Array.isArray(raw.history)) {
    throw new Error('Hybrid search session history is malformed.');
  }
  if (raw.processedMessageIds !== undefined && !Array.isArray(raw.processedMessageIds)) {
    throw new Error('Hybrid search session replay ledger is malformed.');
  }
  const history = Array.isArray(raw.history)
    ? raw.history.map((item) => {
      if (!isChatMessage(item)) throw new Error('Hybrid search session history is malformed.');
      return item;
    }).slice(-16)
    : [];
  const processedMessageIds = Array.isArray(raw.processedMessageIds)
    ? raw.processedMessageIds.map((item) => {
      if (typeof item !== 'string' || item.length === 0 || item.length > 200) {
        throw new Error('Hybrid search session replay ledger is malformed.');
      }
      return item;
    })
    : [];
  const ownerTelegramUserId = raw.ownerTelegramUserId === undefined
    ? undefined
    : typeof raw.ownerTelegramUserId === 'number' && Number.isSafeInteger(raw.ownerTelegramUserId)
      ? raw.ownerTelegramUserId
      : (() => { throw new Error('Hybrid search session owner is malformed.'); })();

  if (raw.draftRequest !== undefined && !isRecord(raw.draftRequest)) {
    throw new Error('Hybrid search session draft request is malformed.');
  }
  const draftRequest = isRecord(raw.draftRequest)
    ? raw.draftRequest as Partial<HybridSearchFlightRequest>
    : undefined;
  if (draftRequest && !StoredDraftRequestSchema.safeParse(draftRequest).success) {
    throw new Error('Hybrid search session draft request is malformed.');
  }
  if (raw.snapshot !== undefined && !isRecord(raw.snapshot)) {
    throw new Error('Hybrid search session snapshot is malformed.');
  }
  const snapshot = isRecord(raw.snapshot)
    ? validateStoredSnapshot(raw.snapshot)
    : undefined;
  if (raw.snapshotFresh !== undefined && typeof raw.snapshotFresh !== 'boolean') {
    throw new Error('Hybrid search session freshness flag is malformed.');
  }
  let snapshotFresh = raw.snapshotFresh === true;
  if (snapshotFresh && !snapshot) {
    throw new Error('Hybrid search session marks a missing snapshot as fresh.');
  }
  if (snapshotFresh && raw.snapshotId !== snapshot?.snapshotId) {
    throw new Error('Hybrid search session snapshot id does not match its snapshot.');
  }

  const pendingClarification = raw.pendingClarification === undefined ? undefined
    : z.object({ fields: z.array(z.enum(PROPOSAL_FIELDS)).max(PROPOSAL_FIELDS.length), intentDraft: StoredDraftRequestSchema.optional() }).strict().parse(raw.pendingClarification);
  snapshotFresh = snapshotFresh && Boolean(snapshot && draftRequest
    && snapshot.route.fromAirportCode === draftRequest.fromAirportCode
    && snapshot.route.toAirportCode === draftRequest.toAirportCode
    && snapshot.departureDate === draftRequest.departureDate)
    && !pendingClarification?.fields.some(field => ['intent', 'fromAirport', 'toAirport', 'departureDate'].includes(field));
  return {
    version: 1,
    chatId,
    ownerTelegramUserId,
    pendingClarification,
    resultView: raw.resultView === undefined ? undefined : StoredResultViewSchema.parse(raw.resultView),
    history,
    draftRequest,
    snapshot,
    snapshotFresh,
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId : undefined,
    caseId: typeof raw.caseId === 'string' ? raw.caseId : undefined,
    lastAttemptCaseId: typeof raw.lastAttemptCaseId === 'string'
      ? raw.lastAttemptCaseId
      : undefined,
    lastCompareCriterion: raw.lastCompareCriterion === 'cheapest'
      || raw.lastCompareCriterion === 'earliest'
      || raw.lastCompareCriterion === 'latest'
      ? raw.lastCompareCriterion
      : undefined,
    lastSearchError: typeof raw.lastSearchError === 'string'
      ? raw.lastSearchError.slice(0, 1000)
      : undefined,
    processedMessageIds,
    updatedAt: typeof raw.updatedAt === 'string'
      ? raw.updatedAt
      : new Date().toISOString(),
  };
}

function validateStoredSnapshot(value: Record<string, unknown>): FlightSearchSnapshot {
  if (
    typeof value.snapshotId !== 'string' ||
    value.snapshotId.length === 0 ||
    typeof value.capturedAt !== 'string' ||
    value.capturedAt.length === 0 ||
    typeof value.departureDate !== 'string' ||
    !isRecord(value.route) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.screenshots)
  ) {
    throw new Error('Hybrid search session snapshot is malformed.');
  }
  const route = value.route as Record<string, unknown>;
  for (const key of ['fromAirportCode', 'fromAirportText', 'toAirportCode', 'toAirportText']) {
    if (typeof route[key] !== 'string' || !route[key]) {
      throw new Error('Hybrid search session snapshot route is malformed.');
    }
  }
  const seen = new Set<string>();
  const candidates = value.candidates.map((candidate) => {
    const parsedCandidate = StoredSnapshotCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success || seen.has(parsedCandidate.data.candidateId)) {
      throw new Error('Hybrid search session snapshot candidate IDs are malformed.');
    }
    seen.add(parsedCandidate.data.candidateId);
    return parsedCandidate.data as FlightSearchSnapshot['candidates'][number];
  });
  const screenshots = value.screenshots.map((batch) => {
    if (!isRecord(batch) || typeof batch.path !== 'string' || batch.path.length === 0 || !Array.isArray(batch.candidateIds)) {
      throw new Error('Hybrid search session snapshot screenshots are malformed.');
    }
    const candidateIds = batch.candidateIds.map((id) => {
      if (typeof id !== 'string' || !seen.has(id)) {
        throw new Error('Hybrid search session screenshot references an unknown candidate.');
      }
      return id;
    });
    return { path: batch.path, candidateIds };
  });
  return {
    snapshotId: value.snapshotId,
    capturedAt: value.capturedAt,
    route: {
      fromAirportCode: route.fromAirportCode as string,
      fromAirportText: route.fromAirportText as string,
      toAirportCode: route.toAirportCode as string,
      toAirportText: route.toAirportText as string,
    },
    departureDate: value.departureDate,
    candidates,
    screenshots,
    observedFlightCount: value.observedFlightCount === undefined
      ? undefined
      : typeof value.observedFlightCount === 'number'
        && Number.isSafeInteger(value.observedFlightCount)
        && value.observedFlightCount >= 0
        ? value.observedFlightCount
        : (() => { throw new Error('Hybrid search session observed flight count is malformed.'); })(),
  };
}

function isChatMessage(value: unknown): value is HybridSearchChatMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (item.role === 'user' || item.role === 'assistant')
    && typeof item.content === 'string'
    && item.content.length <= 4000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isErrno(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
