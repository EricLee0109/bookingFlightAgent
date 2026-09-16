import { AIRLINE_CATALOG, normalizePreferredAirlineCodes } from './airline-catalog';
import { AIRPORT_CATALOG } from './airport-catalog';
import { resolveAirportByCode, resolveAirportFromText } from './airport-resolver';
import {
  ParsedFlightRequestSchema,
  type ParsedFlightRequest,
} from '../contracts/flight';
import { z } from 'zod';

/** Vietnam timezone used by all pilot date and departure-time decisions. */
export const HYBRID_TIME_ZONE = 'Asia/Ho_Chi_Minh';

export type HybridTimeConstraintKind =
  | 'around'
  | 'exact'
  | 'from'
  | 'before'
  | 'after'
  | 'between';

/**
 * Structured time bounds understood by the hybrid search tool.
 *
 * `startTime` and `endTime` are both retained for an interval such as
 * `từ 08h đến 12h`; directional requests use only the applicable bound.
 */
export type HybridTimeConstraint = {
  kind: HybridTimeConstraintKind;
  startTime: string | null;
  endTime: string | null;
  exactTime: string | null;
  startInclusive: boolean;
  endInclusive: boolean;
};

export const HybridTimeConstraintSchema = z.object({
  kind: z.enum(['around', 'exact', 'from', 'before', 'after', 'between']),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  exactTime: z.string().nullable(),
  startInclusive: z.boolean().nullable(),
  endInclusive: z.boolean().nullable(),
});

/**
 * Pilot-only request schema.  The legacy parser schema remains unchanged so
 * existing mock/OpenAI parser contracts do not gain a new required field.
 */
export const HybridSearchFlightRequestSchema = ParsedFlightRequestSchema.safeExtend({
  timeConstraint: HybridTimeConstraintSchema.nullable(),
});

export type HybridSearchFlightRequest = z.infer<
  typeof HybridSearchFlightRequestSchema
>;

export type HybridRequestValidationOptions = {
  /** Vietnam local date used for date resolution and past-date checks. */
  todayIso?: string;
  /** Current time used to exclude already-departed same-day flights. */
  now?: Date;
  /** Original operator text, used only for deterministic safety validation. */
  rawText?: string;
};

export type HybridRequestValidationResult =
  | {
      ok: true;
      request: HybridSearchFlightRequest;
      dateNotice: string | null;
      timeNotice: string | null;
      todayDepartureCutoff: string | null;
    }
  | {
      ok: false;
      reason:
        | 'missing_fields'
        | 'invalid_date'
        | 'past_date'
        | 'today_needs_cutoff'
        | 'ambiguous_time'
        | 'unsupported_request'
        | 'unknown_airline';
      message: string;
      missingFields: string[];
    };

/**
 * Validates and normalizes a model-produced request before Playwright starts.
 *
 * This boundary resolves catalog values, rejects unsupported requirements, and
 * keeps date/time policy independent of the SDK model's prose.
 */
export function validateHybridFlightRequest(
  rawRequest: unknown,
  options: HybridRequestValidationOptions = {},
): HybridRequestValidationResult {
  // The shared parser schema requires a return date for round trips before it
  // gives us a parsed value.  The pilot must report the unsupported trip type
  // itself even when the model omitted that unrelated field.
  if (
    rawRequest &&
    typeof rawRequest === 'object' &&
    (rawRequest as { tripType?: unknown }).tripType === 'round_trip'
  ) {
    return {
      ok: false,
      reason: 'unsupported_request',
      message: 'Pilot hiện chỉ hỗ trợ tìm vé một chiều. Bạn gửi một chặng đi giúp mình nhé.',
      missingFields: [],
    };
  }

  const modelInput = rawRequest && typeof rawRequest === 'object'
    ? { ...(rawRequest as Record<string, unknown>), timeConstraint: (rawRequest as Record<string, unknown>).timeConstraint ?? null }
    : rawRequest;
  const parsed = HybridSearchFlightRequestSchema.safeParse(modelInput);

  if (!parsed.success) {
    return {
      ok: false,
      reason: 'missing_fields',
      message: 'Mình cần thêm thông tin chuyến bay trước khi tìm.',
      missingFields: readMissingFields(rawRequest),
    };
  }

  const request = normalizeHybridRequest(parsed.data, options.rawText);
  const unsupported = findUnsupportedHybridRequest(options.rawText, request);

  if (unsupported) {
    return {
      ok: false,
      reason: 'unsupported_request',
      message: unsupported,
      missingFields: [],
    };
  }

  const rawConstraint = parsed.data.timeConstraint;
  if (rawConstraint && !normalizeConstraint(rawConstraint)) {
    return {
      ok: false,
      reason: 'ambiguous_time',
      message: 'Khoảng giờ chưa hợp lệ. Bạn gửi lại giờ theo dạng HH:mm giúp mình nhé.',
      missingFields: ['timeConstraint'],
    };
  }

  const routeFields = [
    'fromAirportCode', 'fromAirportText', 'toAirportCode', 'toAirportText',
  ] as const;
  const missingRouteFields = routeFields.filter((field) => !request[field]);
  if (missingRouteFields.length > 0) {
    return {
      ok: false,
      reason: 'missing_fields',
      message: formatMissingRouteMessage(missingRouteFields),
      missingFields: missingRouteFields.slice(),
    };
  }
  if (request.fromAirportCode === request.toAirportCode) {
    return {
      ok: false,
      reason: 'missing_fields',
      message: 'Điểm đi và điểm đến cần là hai sân bay khác nhau nhé.',
      missingFields: ['toAirportCode'],
    };
  }
  if (!resolveAirportByCode(request.fromAirportCode!) || !resolveAirportByCode(request.toAirportCode!)) {
    return {
      ok: false,
      reason: 'missing_fields',
      message: 'Mình chỉ tìm được các sân bay có trong danh mục hỗ trợ. Bạn kiểm tra lại điểm đi và điểm đến nhé.',
      missingFields: ['fromAirportCode', 'toAirportCode'],
    };
  }

  let airlineCodes: string[] | null;

  try {
    airlineCodes = normalizePreferredAirlineCodes(
      request.preferredAirlineCodes,
      { strict: true },
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'unknown_airline',
      message: error instanceof Error
        ? error.message
        : 'Hãng bay chưa có trong danh mục hỗ trợ.',
      missingFields: ['preferredAirlineCodes'],
    };
  }

  const withAirlines = {
    ...request,
    preferredAirlineCodes: airlineCodes,
  } satisfies HybridSearchFlightRequest;
  const dateResult = resolveHybridDepartureDate(
    withAirlines.departureDate,
    options.rawText,
    options.todayIso ?? getVietnamTodayIso(options.now),
  );

  if (!dateResult.ok) {
    return {
      ok: false,
      reason: dateResult.reason,
      message: dateResult.message,
      missingFields: dateResult.reason === 'invalid_date' ? ['departureDate'] : [],
    };
  }

  const timeResult = normalizeHybridTimeConstraint(
    withAirlines,
    options.rawText,
  );

  if (!timeResult.ok) {
    return {
      ok: false,
      reason: timeResult.reason,
      message: timeResult.message,
      missingFields: ['timeConstraint'],
    };
  }

  const todayIso = options.todayIso ?? getVietnamTodayIso(options.now);
  const nowParts = getVietnamNowParts(options.now);
  const isToday = dateResult.departureDate === todayIso;

  if (isToday && !timeResult.constraint && !timeResult.explicitTime) {
    return {
      ok: false,
      reason: 'today_needs_cutoff',
      message: `Hôm nay đã là ${formatVietnamDate(todayIso)}. Bạn cho mình biết giờ sớm nhất có thể bay nhé; mình không tự đặt mốc chờ thêm.`,
      missingFields: ['earliestDepartureTime'],
    };
  }

  const requestWithDateAndTime: HybridSearchFlightRequest = {
    ...timeResult.request,
    departureDate: dateResult.departureDate,
    preferredTime: timeResult.request.preferredTime,
    specificTime: timeResult.request.specificTime,
    timeConstraint: timeResult.constraint,
  };

  return {
    ok: true,
    request: requestWithDateAndTime,
    dateNotice: dateResult.notice,
    timeNotice: timeResult.notice,
    todayDepartureCutoff: isToday ? nowParts.time : null,
  };
}

/**
 * Resolves a date from the request and raw Vietnamese wording.
 *
 * A yearless date rolls to the next occurrence on or after Vietnam today.  The
 * loop deliberately handles February 29 by continuing until a valid leap year.
 */
export function resolveHybridDepartureDate(
  requestDate: string | null | undefined,
  rawText: string | undefined,
  todayIso: string,
) {
  const dateMention = parseVietnameseDateMention(rawText ?? '');
  const source = dateMention?.isoLike ?? requestDate;

  if (!source) {
    return {
      ok: false as const,
      reason: 'invalid_date' as const,
      message: 'Bạn cho mình ngày khởi hành cụ thể nhé.',
    };
  }

  const parsedSource = parseDateParts(source, dateMention);

  if (!parsedSource) {
    return {
      ok: false as const,
      reason: 'invalid_date' as const,
      message: `Ngày khởi hành chưa hợp lệ (${source}). Bạn gửi lại theo ngày/tháng giúp mình nhé.`,
    };
  }

  const todayParts = parseDateParts(todayIso);
  if (!todayParts || todayParts.year === null) {
    throw new Error(`Invalid Vietnam today date: ${todayIso}`);
  }
  const todayYear = todayParts.year;
  const yearText = normalizeVietnameseText(rawText ?? '');
  const nextYear = /\bnam sau\b/.test(yearText);
  const thisYear = /\bnam nay\b/.test(yearText);
  if ((nextYear && thisYear) || ((nextYear || thisYear) && parsedSource.hasYear && parsedSource.year !== todayYear + (nextYear ? 1 : 0))) {
    return { ok: false as const, reason: 'invalid_date' as const, message: 'Bạn xác nhận lại năm khởi hành nhé.' };
  }
  if (nextYear || thisYear) {
    parsedSource.year = todayYear + (nextYear ? 1 : 0);
    parsedSource.hasYear = true;
  }

  let resolved = parsedSource.hasYear
    ? `${String(parsedSource.year).padStart(4, '0')}-${String(parsedSource.month).padStart(2, '0')}-${String(parsedSource.day).padStart(2, '0')}`
    : null;

  if (!resolved) {
    for (let year = todayYear; year <= todayYear + 8; year++) {
      if (!isValidCalendarDate(year, parsedSource.month, parsedSource.day)) continue;
      const candidate = `${year.toString().padStart(4, '0')}-${String(parsedSource.month).padStart(2, '0')}-${String(parsedSource.day).padStart(2, '0')}`;
      if (candidate >= todayIso) {
        resolved = candidate;
        break;
      }
    }
  }

  if (!resolved || !isValidIsoDate(resolved)) {
    return {
      ok: false as const,
      reason: 'invalid_date' as const,
      message: `Ngày ${parsedSource.day}/${parsedSource.month} chưa có trong lịch hợp lệ. Bạn kiểm tra lại giúp mình nhé.`,
    };
  }

  if (resolved < todayIso) {
    return {
      ok: false as const,
      reason: 'past_date' as const,
      message: `Ngày ${formatVietnamDate(resolved)} đã qua so với hôm nay. Bạn chọn ngày từ hôm nay trở đi nhé.`,
    };
  }

  return {
    ok: true as const,
    departureDate: resolved,
    notice: `Mình hiểu ngày khởi hành là ${formatVietnamDate(resolved)}.`,
  };
}

/**
 * Parses the pilot's Vietnamese time forms into exact or bounded constraints.
 */
export function parseHybridTimeConstraintFromVietnameseText(
  rawText: string,
): HybridTimeConstraint | null {
  const normalized = normalizeVietnameseText(rawText);
  const range = normalized.match(
    /(?:tu|từ)\s*([01]?\d|2[0-3])\s*(?:h|g|gio)?\s*(?:den|đến|toi|tới)\s*([01]?\d|2[0-3])\s*(?:h|g|gio)?/i,
  );

  if (range) {
    const start = parseHourMinute(range[1]);
    const end = parseHourMinute(range[2]);
    if (start && end) {
      if (start > end) return null;
      return {
        kind: 'between', startTime: start, endTime: end, exactTime: null,
        startInclusive: true, endInclusive: true,
      };
    }
  }

  // Preserve both bounds when an operator combines directional phrases, for
  // example `sau 08h trước 12h` or `từ 08h trước 12h`.  Parsing only the first
  // match would silently broaden the request to a one-sided interval.
  const directionalMatches = Array.from(normalized.matchAll(
    /(?<!\S)(sau|truoc|tu|khong\s+truoc|den|toi)\s*([01]?\d|2[0-3])\s*(?::|h|g|gio)\s*([0-5]\d)?/gi,
  ));
  const startMatch = directionalMatches.find((item) =>
    ['sau', 'tu', 'khong truoc'].includes(item[1].replace(/\s+/g, ' ')),
  );
  const endMatch = directionalMatches.find((item) =>
    ['truoc', 'den', 'toi'].includes(item[1]),
  );
  if (startMatch && endMatch && startMatch.index !== endMatch.index) {
    const start = toSessionAdjustedTime(
      Number(startMatch[2]),
      Number(startMatch[3] ?? 0),
      detectSession(normalized, startMatch.index ?? 0, startMatch[0].length),
    );
    const end = toSessionAdjustedTime(
      Number(endMatch[2]),
      Number(endMatch[3] ?? 0),
      detectSession(normalized, endMatch.index ?? 0, endMatch[0].length),
    );
    if (start && end && start <= end) {
      const normalizedStartPrefix = startMatch[1].replace(/\s+/g, ' ');
      return {
        kind: 'between',
        startTime: start,
        endTime: end,
        exactTime: null,
        startInclusive: normalizedStartPrefix !== 'sau',
        endInclusive: endMatch[1] !== 'truoc',
      };
    }
    return null;
  }

  const match = findPilotTimeMatch(normalized);
  if (!match) return null;
  const time = toSessionAdjustedTime(match.hour, match.minute, match.session);
  if (!time) return null;

  if (/(?:^|\s)(?:dung|đúng)\s*$/.test(match.prefix)) {
    return { kind: 'exact', startTime: null, endTime: null, exactTime: time, startInclusive: true, endInclusive: true };
  }
  if (/(?:^|\s)(?:tu|từ|khong truoc|không trước)\s*$/.test(match.prefix)) {
    return { kind: 'from', startTime: time, endTime: null, exactTime: null, startInclusive: true, endInclusive: false };
  }
  if (/(?:^|\s)(?:truoc|trước)\s*$/.test(match.prefix)) {
    return { kind: 'before', startTime: null, endTime: time, exactTime: null, startInclusive: false, endInclusive: false };
  }
  if (/(?:^|\s)(?:sau|sàu)\s*$/.test(match.prefix)) {
    return { kind: 'after', startTime: time, endTime: null, exactTime: null, startInclusive: false, endInclusive: false };
  }

  return { kind: 'around', startTime: null, endTime: null, exactTime: time, startInclusive: true, endInclusive: true };
}

/**
 * Converts a validated hybrid time constraint to a display label for Telegram.
 */
export function hybridTimeConstraintLabel(constraint: HybridTimeConstraint) {
  if (constraint.kind === 'between') {
    return `trong khoảng ${constraint.startTime}-${constraint.endTime}`;
  }
  if (constraint.kind === 'around') {
    return `gần ${constraint.exactTime} (${formatAroundTimeLabel(constraint.exactTime!)})`;
  }
  if (constraint.kind === 'exact') return `đúng ${constraint.exactTime}`;
  if (constraint.kind === 'from') return `từ ${constraint.startTime}`;
  if (constraint.kind === 'before') return `trước ${constraint.endTime}`;
  return `sau ${constraint.startTime}`;
}

/**
 * Normalizes model fields and catalog values without performing any browser IO.
 */
export function normalizeHybridRequest(
  request: HybridSearchFlightRequest,
  rawText?: string,
): HybridSearchFlightRequest {
  const from = resolveAirportByCode(request.fromAirportCode ?? '')
    ?? resolveAirportFromText(request.fromAirportText ?? '');
  const to = resolveAirportByCode(request.toAirportCode ?? '')
    ?? resolveAirportFromText(request.toAirportText ?? '');
  const rawConstraint = request.timeConstraint;
  const parsedConstraint = rawConstraint
    ? normalizeConstraint(rawConstraint)
    : parseHybridTimeConstraintFromVietnameseText(rawText ?? '');

  return {
    ...request,
    fromAirportCode: from?.code ?? request.fromAirportCode,
    fromAirportText: from?.text ?? request.fromAirportText,
    toAirportCode: to?.code ?? request.toAirportCode,
    toAirportText: to?.text ?? request.toAirportText,
    preferredAirlineCodes: request.preferredAirlineCodes,
    preferredTime: parsedConstraint ? 'specific_time' : request.preferredTime,
    specificTime: parsedConstraint?.exactTime ?? request.specificTime,
    timeConstraint: parsedConstraint,
  };
}

function normalizeHybridTimeConstraint(
  request: HybridSearchFlightRequest,
  rawText?: string,
) {
  const constraint = request.timeConstraint
    ? normalizeConstraint(request.timeConstraint)
    : parseHybridTimeConstraintFromVietnameseText(rawText ?? '');

  if (request.preferredTime === 'specific_time' && !request.specificTime && !constraint) {
    return {
      ok: false as const,
      reason: 'ambiguous_time' as const,
      message: 'Bạn cho mình biết 5h sáng, 5h chiều hay 5h tối nhé.',
    };
  }

  if (!constraint) {
    if (request.specificTime) {
      const specificTime = normalizeClockTime(request.specificTime);
      if (!specificTime) {
        return {
          ok: false as const,
          reason: 'ambiguous_time' as const,
          message: 'Bạn cho mình biết giờ theo dạng HH:mm hợp lệ nhé.',
        };
      }
      return {
        ok: true as const,
        request: {
          ...request,
          preferredTime: 'specific_time' as const,
          specificTime,
        },
        constraint: null,
        explicitTime: true,
        notice: `Mình hiểu giờ bay là gần ${specificTime} (${formatAroundTimeLabel(specificTime)}).`,
      };
    }
    return {
      ok: true as const,
      request,
      constraint: null,
      explicitTime: false,
      notice: null,
    };
  }

  const notice = `Mình hiểu giờ bay là ${hybridTimeConstraintLabel(constraint)}.`;
  return {
    ok: true as const,
    request: {
      ...request,
      preferredTime: constraint.kind === 'around' || constraint.kind !== 'between'
        ? 'specific_time'
        : request.preferredTime,
      specificTime: constraint.exactTime ?? request.specificTime,
    },
    constraint,
    explicitTime: true,
    notice,
  };
}

function normalizeConstraint(value: {
  kind: HybridTimeConstraintKind;
  startTime?: string | null;
  endTime?: string | null;
  exactTime?: string | null;
  startInclusive?: boolean | null;
  endInclusive?: boolean | null;
}) {
  const hasStart = value.startTime !== null && value.startTime !== undefined;
  const hasEnd = value.endTime !== null && value.endTime !== undefined;
  const hasExact = value.exactTime !== null && value.exactTime !== undefined;
  const start = normalizeClockTime(value.startTime);
  const end = normalizeClockTime(value.endTime);
  const exact = normalizeClockTime(value.exactTime);

  // A malformed value or a bound supplied for the wrong operator must fail
  // closed.  Otherwise a bad model response could be normalized into a
  // weaker request and silently return unrelated flights.
  if ((hasStart && !start) || (hasEnd && !end) || (hasExact && !exact)) {
    return null;
  }

  if (value.kind === 'between' && start && end) {
    if (hasExact) return null;
    if (start > end) return null;
    return {
      kind: 'between' as const, startTime: start, endTime: end, exactTime: null,
      startInclusive: value.startInclusive ?? true,
      endInclusive: value.endInclusive ?? true,
    };
  }
  if (value.kind === 'from' && start) {
    if (hasEnd || hasExact) return null;
    return {
      kind: 'from' as const, startTime: start, endTime: null, exactTime: null,
      startInclusive: value.startInclusive ?? true, endInclusive: false,
    };
  }
  if (value.kind === 'before' && end) {
    if (hasStart || hasExact) return null;
    return {
      kind: 'before' as const, startTime: null, endTime: end, exactTime: null,
      startInclusive: false, endInclusive: value.endInclusive ?? false,
    };
  }
  if (value.kind === 'after' && start) {
    if (hasEnd || hasExact) return null;
    return {
      kind: 'after' as const, startTime: start, endTime: null, exactTime: null,
      startInclusive: value.startInclusive ?? false, endInclusive: false,
    };
  }
  if (value.kind === 'exact' && exact) {
    if (hasStart || hasEnd) return null;
    return { kind: 'exact' as const, startTime: null, endTime: null, exactTime: exact, startInclusive: true, endInclusive: true };
  }
  if (value.kind === 'around' && exact) {
    if (hasStart || hasEnd) return null;
    return { kind: 'around' as const, startTime: null, endTime: null, exactTime: exact, startInclusive: true, endInclusive: true };
  }
  return null;
}

function formatAroundTimeLabel(value: string) {
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  const start = Math.max(0, hour * 60 + minute - 120);
  const end = Math.min(1439, hour * 60 + minute + 120);
  return `${formatClockMinute(start)}-${formatClockMinute(end)}`;
}

function formatClockMinute(totalMinutes: number) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function findUnsupportedHybridRequest(rawText: string | undefined, request: HybridSearchFlightRequest) {
  const text = normalizeVietnameseText(rawText ?? '');
  if (request.tripType === 'round_trip' || /\b(?:khu hoi|round trip|return)\b/.test(text)) {
    return 'Pilot hiện chỉ hỗ trợ tìm vé một chiều. Bạn gửi một chặng đi giúp mình nhé.';
  }
  if (/\b(?:qua canh|transit|stop|stops|dung lai|nhiều chặng|nhieu chang)\b/.test(text)) {
    return 'Pilot chưa hỗ trợ lọc theo số điểm dừng. Bạn cho mình tiêu chí tuyến, ngày, giờ hoặc hãng bay nhé.';
  }
  if (/\b(?:hanh ly|baggage|vali|checked bag)\b/.test(text)) {
    return 'Pilot chưa hỗ trợ lọc hành lý. Bạn cho mình tiêu chí tuyến, ngày, giờ hoặc hãng bay nhé.';
  }
  if (/\b(?:nhanh nhat|nhanh hơn|nhanh hon|fastest|shortest)\b/.test(text)) {
    return 'Pilot chưa hỗ trợ lọc theo thời lượng hoặc chuyến nhanh nhất.';
  }
  return null;
}

function readMissingFields(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const fields = (value as { missingFields?: unknown }).missingFields;
  return Array.isArray(fields) ? fields.filter((field): field is string => typeof field === 'string') : [];
}

/** Asks only for the route side that remains unresolved at this boundary. */
function formatMissingRouteMessage(fields: readonly string[]) {
  const missingFrom = fields.some((field) => field.startsWith('fromAirport'));
  const missingTo = fields.some((field) => field.startsWith('toAirport'));
  if (missingFrom && missingTo) return 'Bạn cho mình biết đủ điểm đi và điểm đến nhé.';
  if (missingFrom) return 'Bạn cho mình biết điểm đi nhé.';
  if (missingTo) return 'Bạn cho mình biết điểm đến nhé.';
  return 'Bạn cho mình biết đủ điểm đi và điểm đến nhé.';
}

function parseVietnameseDateMention(rawText: string) {
  const normalized = normalizeVietnameseText(rawText);
  const iso = normalized.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    return {
      isoLike: `${iso[1]}-${iso[2]}-${iso[3]}`,
      day: Number(iso[3]),
      month: Number(iso[2]),
      year: Number(iso[1]),
      hasExplicitYear: true,
    };
  }
  const local = normalized.match(/\b(\d{1,2})\s*(?:\/|-)\s*(\d{1,2})(?:\s*(?:\/|-)\s*(20\d{2}))?\b/);
  if (!local) return null;
  return {
      isoLike: local[3]
      ? `${local[3]}-${local[2]}-${local[1]}`
      : `${local[1]}/${local[2]}`,
    day: Number(local[1]),
    month: Number(local[2]),
    year: local[3] ? Number(local[3]) : null,
    hasExplicitYear: Boolean(local[3]),
  };
}

function parseDateParts(
  value: string,
  mention?: { day: number; month: number; year?: number | null; hasExplicitYear?: boolean } | null,
) {
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return {
      year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), hasYear: true,
    };
  }
  const local = value.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}))?$/);
  if (local) {
    return {
      year: local[3] ? Number(local[3]) : null,
      month: Number(local[2]), day: Number(local[1]), hasYear: Boolean(local[3]),
    };
  }
  if (mention) {
    return { year: mention.year ?? null, month: mention.month, day: mention.day, hasYear: Boolean(mention.year) };
  }
  return null;
}

function isValidIsoDate(value: string) {
  const parts = parseDateParts(value);
  return Boolean(parts && parts.hasYear && isValidCalendarDate(parts.year!, parts.month, parts.day));
}

function isValidCalendarDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

function normalizeClockTime(value: string | null | undefined) {
  if (!value) return null;
  const match = value.match(/^(\d{1,2})(?::|h|g|gio)?(\d{2})?$/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  return hour <= 23 && minute <= 59
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : null;
}

function parseHourMinute(value: string) {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23
    ? `${String(hour).padStart(2, '0')}:00`
    : null;
}

function findPilotTimeMatch(normalized: string) {
  // Do not start at the second digit of an invalid token such as `25h` or
  // `108h`; otherwise the suffix `5h`/`08h` could be misread as a valid time.
  const pattern = /(?<!\d)(dung|tu|khong truoc|truoc|sau|bay|khoang|around)?\s*([01]?\d|2[0-3])\s*(?::|h|g|gio)\s*([0-5]\d)?(?!\d)/gi;
  for (const match of normalized.matchAll(pattern)) {
    const prefix = match[1] ?? '';
    const hour = Number(match[2]);
    const minute = Number(match[3] ?? 0);
    const session = detectSession(normalized, match.index ?? 0, match[0].length);
    return { prefix, hour, minute, session };
  }
  return null;
}

function detectSession(text: string, index: number, length: number) {
  const context = text.slice(Math.max(0, index - 24), index + length + 24);
  if (/\b(?:sang som|rang sang|sang)\b/.test(context)) return 'morning' as const;
  if (/\bchieu\b/.test(context)) return 'afternoon' as const;
  if (/\b(?:toi|dem)\b/.test(context)) return 'evening' as const;
  return null;
}

function toSessionAdjustedTime(hour: number, minute: number, session: 'morning' | 'afternoon' | 'evening' | null) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (session === 'morning' && hour === 12) return `00:${String(minute).padStart(2, '0')}`;
  if ((session === 'afternoon' || session === 'evening') && hour < 12) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeVietnameseText(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getVietnamTodayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HYBRID_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getVietnamNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HYBRID_TIME_ZONE,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return { time: `${parts.hour}:${parts.minute}` };
}

function formatVietnamDate(iso: string) {
  const parts = iso.split('-');
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

/** Catalog is exported alongside the validation helpers for prompt/test use. */
export const HYBRID_AIRPORT_CATALOG = AIRPORT_CATALOG;
export const HYBRID_AIRLINE_CATALOG = AIRLINE_CATALOG;
