import {
  resolveFlightAirlineFilter,
  selectCandidatesByAirlineFilter,
} from './flight-airline-filters';
import { normalizePreferredAirlineCodes } from '../../agent/airline-catalog';
import {
  isFlightCandidateInTimeFilter,
  resolveFlightTimeFilter,
} from './flight-time-filters';
import type {
  FlightResultCandidate,
  FlightResultFilterSummary,
} from './flight-result-types';
import type { SearchFlightsInput } from './search-flight-input';
import type { HybridTimeConstraint } from '../../agent/hybrid-flight-request';

const DEFAULT_HYBRID_RESULT_LIMIT = 5;
const DEFAULT_SCREENSHOT_BATCH_SIZE = 10;

/** A candidate copied from one immutable browser-result snapshot. */
export type FlightSearchSnapshotCandidate = FlightResultCandidate & {
  candidateId: string;
};

/** One screenshot and the snapshot candidates visible in that screenshot. */
export type FlightSearchSnapshotScreenshotBatch = {
  path: string;
  candidateIds: string[];
};

/**
 * Immutable, case-scoped output of one 1Booking result observation.
 *
 * The full candidate list is retained even when a requested filter produces no
 * matches.  Later compare/filter calls can therefore use this object without
 * reopening the browser or silently widening the original search.
 */
export type FlightSearchSnapshot = {
  snapshotId: string;
  capturedAt: string;
  route: {
    fromAirportCode: string;
    fromAirportText: string;
    toAirportCode: string;
    toAirportText: string;
  };
  departureDate: string;
  candidates: FlightSearchSnapshotCandidate[];
  screenshots: FlightSearchSnapshotScreenshotBatch[];
  /** The count reported by the page before parsing/filtering. */
  observedFlightCount?: number;
};

export type FlightSearchSnapshotInput = {
  snapshotId?: string;
  capturedAt?: Date | string;
  route: FlightSearchSnapshot['route'];
  departureDate: string;
  candidates: FlightResultCandidate[];
  screenshotPaths?: string[];
  screenshotBatches?: FlightSearchSnapshotScreenshotBatch[];
  screenshotBatchSize?: number;
  observedFlightCount?: number;
};

export type FlightSearchSnapshotFilterRequest = {
  preferredTime?: SearchFlightsInput['preferredTime'];
  specificTime?: string | null;
  timeConstraint?: HybridTimeConstraint | null;
  preferredAirlineCodes?: string[] | null;
  resultRanking?: 'cheapest' | null;
  criterion?: 'cheapest' | 'earliest' | 'latest';
  limit?: number;
  /** Zero-based offset into the fully ranked, verified result set. */
  offset?: number;
  /** Optional verified IDs to compare; omitted means every snapshot candidate. */
  candidateIds?: string[];
  /** When true, only the supplied snapshot is considered; no browser call. */
  snapshotId?: string;
};

export type FlightSearchSnapshotFilterResult = {
  snapshotId: string;
  candidates: FlightSearchSnapshotCandidate[];
  matchedCandidates: FlightSearchSnapshotCandidate[];
  selectedCandidates: FlightSearchSnapshotCandidate[];
  rankedCandidateIds: string[];
  offset: number;
  cardIndexes: number[];
  summary: FlightSearchSnapshotFilterSummary;
  noMatches: boolean;
  unrankable: boolean;
};

export type FlightSearchSnapshotFilterSummary = FlightResultFilterSummary & {
  noMatches: boolean;
  unrankable: boolean;
  comparedCandidateIds: string[];
  excludedPastDepartureCount: number;
};

/**
 * Copies all observed candidates into a durable snapshot with local IDs.
 *
 * IDs are deterministic within the snapshot (`candidate-<cardIndex>`), which
 * keeps model comparisons stable across serialization and replay.
 */
export function createFlightSearchSnapshot(
  input: FlightSearchSnapshotInput,
): FlightSearchSnapshot {
  const snapshotId = input.snapshotId ?? `FS-${Date.now()}-${randomSuffix()}`;
  const assignedIds = new Set<string>();
  const candidates = input.candidates.map((candidate) => {
    // Candidate IDs belong to this snapshot.  Never carry a caller-supplied
    // ID from another snapshot into the new namespace.
    const baseId = `candidate-${candidate.cardIndex}`;
    let candidateId = baseId;
    let suffix = 2;
    while (assignedIds.has(candidateId)) candidateId = `${baseId}-${suffix++}`;
    assignedIds.add(candidateId);
    return { ...candidate, candidateId };
  });
  const screenshots = input.screenshotBatches
    ? input.screenshotBatches.map((batch) => {
        if (!batch.path) {
          throw new Error('Screenshot batch thiếu đường dẫn bằng chứng.');
        }
        assertVerifiedCandidateIds(candidates, batch.candidateIds);
        return { path: batch.path, candidateIds: batch.candidateIds.slice() };
      })
    : buildScreenshotBatches(
        input.screenshotPaths ?? [],
        candidates,
        input.screenshotBatchSize ?? DEFAULT_SCREENSHOT_BATCH_SIZE,
      );

  return {
    snapshotId,
    capturedAt: toIsoString(input.capturedAt),
    route: { ...input.route },
    departureDate: input.departureDate,
    candidates,
    screenshots,
    observedFlightCount: input.observedFlightCount,
  };
}

/** Alias for callers that prefer the shorter snapshot factory name. */
export const buildFlightSearchSnapshot = createFlightSearchSnapshot;

/**
 * Filters/compares the full immutable snapshot deterministically.
 *
 * Cheapest ranking uses only the visible card price (`priceAmount`), excludes
 * null prices, and resolves ties by the original card index.
 */
export function filterFlightSearchSnapshot(
  snapshot: FlightSearchSnapshot,
  request: FlightSearchSnapshotFilterRequest = {},
  options: { now?: Date; todayIso?: string } = {},
): FlightSearchSnapshotFilterResult {
  if (request.snapshotId && request.snapshotId !== snapshot.snapshotId) {
    throw new Error('Snapshot không thuộc request hiện tại. Vui lòng tìm lại chuyến.');
  }

  // Hybrid filtering must fail closed when a model or follow-up contains an
  // unknown airline; silently dropping it would change the operator's request.
  const strictAirlineCodes = normalizePreferredAirlineCodes(
    request.preferredAirlineCodes,
    { strict: true },
  );
  const airlineFilter = resolveFlightAirlineFilter(strictAirlineCodes);
  const timeFilter = resolveFlightTimeFilter({
    preferredTime: request.preferredTime,
    specificTime: request.specificTime,
    timeConstraint: request.timeConstraint,
  });
  const now = options.now ?? new Date();
  const todayIso = options.todayIso ?? getTodayIso(now);
  const currentClock = getVietnamClock(now);
  const beforeDeparture = (candidate: FlightSearchSnapshotCandidate) =>
    snapshot.departureDate < todayIso ||
    (snapshot.departureDate === todayIso &&
      toSecondOfDay(candidate.departureTime) <= currentClock.secondOfDay);
  const comparisonCandidates = request.candidateIds
    ? getVerifiedCandidates(snapshot, request.candidateIds)
    : snapshot.candidates;
  const eligibleCandidates = comparisonCandidates.filter((candidate) => !beforeDeparture(candidate));
  const excludedPastDepartureCount = comparisonCandidates.length - eligibleCandidates.length;
  const airlineScopedCandidates = selectCandidatesByAirlineFilter({
    candidates: eligibleCandidates,
    airlineFilter,
  }) as FlightSearchSnapshotCandidate[];
  const matchedCandidates = timeFilter
    ? airlineScopedCandidates.filter((candidate) =>
        isFlightCandidateInTimeFilter(candidate, timeFilter),
      )
    : airlineScopedCandidates;
  const rankedCandidates = rankSnapshotCandidates(
    matchedCandidates,
    request.criterion ?? request.resultRanking,
  );
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= rankedCandidates.length)) {
    throw new Error('Trang kết quả không hợp lệ.');
  }
  const selectedCandidates = rankedCandidates.slice(offset, offset + clampLimit(request.limit));
  const criterion = request.criterion ?? request.resultRanking;
  const unrankable = criterion === 'cheapest' && matchedCandidates.length > 0 && selectedCandidates.length === 0;
  const summary = buildSnapshotSummary({
    request,
    airlineFilter,
    timeFilter,
    snapshot,
    matchedCandidates,
    selectedCandidates,
    noMatches: matchedCandidates.length === 0,
    unrankable,
    excludedPastDepartureCount,
  });

  return {
    snapshotId: snapshot.snapshotId,
    candidates: snapshot.candidates,
    matchedCandidates,
    selectedCandidates,
    rankedCandidateIds: rankedCandidates.map(candidate => candidate.candidateId),
    offset,
    cardIndexes: selectedCandidates.map((candidate) => candidate.cardIndex),
    summary,
    noMatches: matchedCandidates.length === 0,
    unrankable,
  };
}

/** Alias used by the hybrid tool layer. */
export const compareFlightSearchSnapshot = filterFlightSearchSnapshot;

/** Returns whether a new parsed request can reuse the current snapshot. */
export function isSameFlightSearchRouteAndDate(
  snapshot: FlightSearchSnapshot,
  input: Pick<SearchFlightsInput, 'fromAirportCode' | 'toAirportCode' | 'departureDate'>,
) {
  return snapshot.route.fromAirportCode === input.fromAirportCode
    && snapshot.route.toAirportCode === input.toAirportCode
    && snapshot.departureDate === input.departureDate;
}

/** Return only complete, correctly ordered evidence; never send a mixed older batch. */
export function screenshotsForFlightSearchResult(
  snapshot: FlightSearchSnapshot,
  candidateIds: string[],
) {
  assertVerifiedCandidateIds(snapshot.candidates, candidateIds);
  const selected = snapshot.screenshots.filter(batch => {
    const start = candidateIds.indexOf(batch.candidateIds[0]);
    return start >= 0 && batch.candidateIds.length > 0
      && batch.candidateIds.every((id, offset) => candidateIds[start + offset] === id);
  }).sort((left, right) => candidateIds.indexOf(left.candidateIds[0]) - candidateIds.indexOf(right.candidateIds[0]));
  // Partial image coverage is misleading too. Keep old evidence in storage only.
  const covered = selected.flatMap(batch => batch.candidateIds);
  return covered.length === candidateIds.length && covered.every((id, index) => id === candidateIds[index]) ? selected : [];
}

export type FlightSearchSnapshotReply = {
  text: string;
  candidateIds: string[];
  screenshots: FlightSearchSnapshotScreenshotBatch[];
  captions: Array<{
    path: string;
    candidateIds: string[];
    caption: string;
  }>;
};

/**
 * Formats a customer-facing summary from one verified filter result.
 *
 * The result object is treated as a selection of IDs only.  Display values
 * are re-read from the matching snapshot candidates so a caller cannot inject
 * a fabricated price, flight number, or screenshot reference into Telegram.
 */
export function formatFlightSearchSnapshotReply(
  snapshot: FlightSearchSnapshot,
  result: FlightSearchSnapshotFilterResult,
): FlightSearchSnapshotReply {
  if (result.snapshotId !== snapshot.snapshotId) {
    throw new Error('Kết quả so sánh không thuộc snapshot hiện tại.');
  }

  const selectedIds = result.selectedCandidates.map((candidate) => candidate.candidateId);
  assertVerifiedCandidateIds(snapshot.candidates, selectedIds);
  const selectedById = new Map(
    snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const selectedCandidates = selectedIds.map((candidateId) => {
    const candidate = selectedById.get(candidateId);
    if (!candidate) throw new Error(`Candidate ID không thuộc snapshot: ${candidateId}.`);
    return candidate;
  });
  const screenshots = screenshotsForFlightSearchResult(snapshot, selectedIds);
  const routeText = `${snapshot.route.fromAirportCode} → ${snapshot.route.toAirportCode}`;
  const dateText = formatSnapshotDate(snapshot.departureDate);
  const filterText = [
    result.summary.requestedAirlineNames?.length
      ? `hãng ${result.summary.requestedAirlineNames.join(', ')}`
      : null,
    result.summary.requestedTimeConstraintLabel ?? result.summary.requestedTimeWindowLabel,
    result.summary.ranking === 'cheapest' ? 'xếp theo giá hiển thị thấp nhất' : null,
  ].filter((value): value is string => Boolean(value));
  const contextText = filterText.length > 0 ? ` (${filterText.join(', ')})` : '';
  const header = `Kết quả ${routeText}, ngày ${dateText}${contextText}.`;

  let text: string;
  if (result.unrankable) {
    text = `${header}\nMình chưa thể xếp chuyến rẻ nhất vì các chuyến phù hợp không có giá hiển thị.`;
  } else if (result.noMatches) {
    text = `${header}\nMình chưa tìm thấy chuyến phù hợp trong ${snapshot.candidates.length} chuyến đã quan sát. Mình chưa tự nới điều kiện; bạn muốn đổi tiêu chí nào không?`;
  } else {
    const lines = selectedCandidates.map((candidate, index) => {
      const timeText = candidate.arrivalTime
        ? `${candidate.departureTime}-${candidate.arrivalTime}`
        : candidate.departureTime;
      const priceText = candidate.priceAmount === null
        ? 'giá hiển thị chưa có'
        : `${formatVnd(candidate.priceAmount)} VND`;
      return `${index + 1}. ${candidate.flightNumber} · ${candidate.airlineName} · ${timeText} · ${priceText}`;
    });
    text = lines.length > 0
      ? `${header}\n${lines.join('\n')}`
      : `${header}\nMình chưa có chuyến nào đủ dữ liệu để hiển thị.`;
  }

  const captions = screenshots.map((batch, index) => {
    const batchCandidates = batch.candidateIds
      .map((candidateId) => selectedById.get(candidateId))
      .filter((candidate): candidate is FlightSearchSnapshotCandidate => Boolean(candidate));
    const times = batchCandidates.map((candidate) => candidate.departureTime).join(', ');
    return {
      path: batch.path,
      candidateIds: batch.candidateIds.slice(),
      caption: times
        ? `Ảnh ${index + 1}: các chuyến đã chọn, giờ khởi hành ${times}.`
        : `Ảnh ${index + 1}: bằng chứng kết quả tìm kiếm.`,
    };
  });

  return { text, candidateIds: selectedIds, screenshots, captions };
}

/** Alias used by the hybrid Telegram formatter. */
export const formatHybridSearchSnapshotReply = formatFlightSearchSnapshotReply;

/** Resolves only IDs verified against this exact immutable snapshot. */
function getVerifiedCandidates(
  snapshot: FlightSearchSnapshot,
  candidateIds: string[],
) {
  assertVerifiedCandidateIds(snapshot.candidates, candidateIds);
  const allowed = new Set(candidateIds);
  return snapshot.candidates.filter((candidate) => allowed.has(candidate.candidateId));
}

/** Rejects fabricated or cross-snapshot candidate IDs before any comparison. */
function assertVerifiedCandidateIds(
  candidates: FlightSearchSnapshotCandidate[],
  candidateIds: string[],
) {
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  const invalid = candidateIds.filter((candidateId) => !known.has(candidateId));
  if (invalid.length > 0) {
    throw new Error(`Candidate ID không thuộc snapshot: ${invalid.join(', ')}.`);
  }
}

function rankSnapshotCandidates(
  candidates: FlightSearchSnapshotCandidate[],
  criterion?: 'cheapest' | 'earliest' | 'latest' | null,
) {
  const copy = candidates.slice();
  if (criterion === 'cheapest') {
    return copy
      .filter((candidate) => candidate.priceAmount !== null)
      .sort((left, right) =>
        (left.priceAmount! - right.priceAmount!) ||
        (left.cardIndex - right.cardIndex),
      );
  }
  if (criterion === 'earliest') {
    return copy.sort((left, right) =>
      (toSecondOfDay(left.departureTime) - toSecondOfDay(right.departureTime)) ||
      (left.cardIndex - right.cardIndex),
    );
  }
  if (criterion === 'latest') {
    return copy.sort((left, right) =>
      (toSecondOfDay(right.departureTime) - toSecondOfDay(left.departureTime)) ||
      (left.cardIndex - right.cardIndex),
    );
  }
  return copy.sort((left, right) => left.cardIndex - right.cardIndex);
}

function buildSnapshotSummary(input: {
  request: FlightSearchSnapshotFilterRequest;
  airlineFilter: ReturnType<typeof resolveFlightAirlineFilter>;
  timeFilter: ReturnType<typeof resolveFlightTimeFilter>;
  snapshot: FlightSearchSnapshot;
  matchedCandidates: FlightSearchSnapshotCandidate[];
  selectedCandidates: FlightSearchSnapshotCandidate[];
  noMatches: boolean;
  unrankable: boolean;
  excludedPastDepartureCount: number;
}): FlightSearchSnapshotFilterSummary {
  const prices = input.selectedCandidates
    .map((candidate) => candidate.priceAmount)
    .filter((price): price is number => price !== null)
    .sort((left, right) => left - right);
  const priceRangeText = prices.length === 0
    ? null
    : prices[0] === prices[prices.length - 1]
      ? `${formatVnd(prices[0])} VND`
      : `${formatVnd(prices[0])} VND - ${formatVnd(prices[prices.length - 1])} VND`;

  return {
    ranking: input.request.resultRanking,
    requestedAirlineCodes: input.airlineFilter?.codes ?? null,
    requestedAirlineNames: input.airlineFilter?.names ?? null,
    requestedTimeBucket: input.timeFilter?.kind === 'bucket' ? input.timeFilter.bucket : null,
    requestedTimeBucketLabel: input.timeFilter?.kind === 'bucket' ? input.timeFilter.label : null,
    requestedSpecificTime: input.timeFilter?.kind === 'specific_window'
      ? input.timeFilter.specificTime
      : null,
    requestedTimeWindowLabel: input.timeFilter && input.timeFilter.kind !== 'bucket'
      ? input.timeFilter.label
      : null,
    requestedTimeConstraintLabel: input.timeFilter && input.timeFilter.kind !== 'bucket'
      ? input.timeFilter.label
      : null,
    totalVisibleCount: input.snapshot.candidates.length,
    matchedCount: input.matchedCandidates.length,
    displayedCount: input.selectedCandidates.length,
    priceRangeText,
    noMatches: input.noMatches,
    unrankable: input.unrankable,
    comparedCandidateIds: input.matchedCandidates.map((candidate) => candidate.candidateId),
    excludedPastDepartureCount: input.excludedPastDepartureCount,
  };
}

function buildScreenshotBatches(
  paths: string[],
  candidates: FlightSearchSnapshotCandidate[],
  batchSize: number,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('Screenshot batch size phải là số nguyên dương.');
  }
  if (
    paths.length > 0 &&
    candidates.length > 0 &&
    paths.length !== Math.ceil(candidates.length / batchSize)
  ) {
    throw new Error('Số ảnh chụp không khớp với số nhóm ứng viên trong snapshot.');
  }

  return paths.map((path, index) => {
    if (!path) {
      throw new Error('Screenshot batch thiếu đường dẫn bằng chứng.');
    }
    return {
      path,
      candidateIds: candidates
        .slice(index * batchSize, (index + 1) * batchSize)
        .map((candidate) => candidate.candidateId),
    };
  });
}

function clampLimit(limit?: number) {
  if (!Number.isFinite(limit)) return DEFAULT_HYBRID_RESULT_LIMIT;
  return Math.max(1, Math.min(30, Math.floor(limit!)));
}

function toIsoString(value?: Date | string) {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function toSecondOfDay(value: string) {
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0)
    : Number.MAX_SAFE_INTEGER;
}

function getTodayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getVietnamClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    time: `${parts.hour}:${parts.minute}`,
    secondOfDay: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

function formatVnd(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatSnapshotDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}
