import {
  type ParsedFlightRequest,
} from '../contracts/flight';

export type SpecificTimeParseResult =
  | {
      kind: 'none';
    }
  | {
      kind: 'time';
      time: string;
      rawText: string;
    }
  | {
      kind: 'ambiguous';
      rawText: string;
      hour: number;
    };

export type ParsedFlightSpecificTimeNormalizationResult =
  | {
      ok: true;
      parsed: ParsedFlightRequest;
    }
  | {
      ok: false;
      reason: 'ambiguous_specific_time';
      ambiguousTime: string;
    };

/**
 * Applies deterministic Vietnamese time parsing after AI parsing.
 *
 * The AI parser may recognize that a request has a specific time, but this
 * helper owns the local safety rule for ambiguous 12-hour expressions such as
 * `5h` without `sang/chieu/toi`.
 */
export function normalizeParsedSpecificTimeFromRawMessage(
  parsed: ParsedFlightRequest,
  rawMessage: string,
): ParsedFlightSpecificTimeNormalizationResult {
  const rawTime = parseSpecificTimeFromVietnameseText(rawMessage);

  if (rawTime.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous_specific_time',
      ambiguousTime: rawTime.rawText,
    };
  }

  if (rawTime.kind === 'time') {
    return {
      ok: true,
      parsed: {
        ...parsed,
        preferredTime: 'specific_time',
        specificTime: rawTime.time,
      },
    };
  }

  if (parsed.preferredTime === 'specific_time') {
    const normalizedSpecificTime = normalizeSpecificTimeValue(parsed.specificTime);

    return {
      ok: true,
      parsed: {
        ...parsed,
        specificTime: normalizedSpecificTime,
      },
    };
  }

  return {
    ok: true,
    parsed,
  };
}

/**
 * Parses common Vietnamese exact-time forms from raw operator text.
 *
 * Supported examples:
 * - `17h`, `17g`, `17 gio`, `17:00`
 * - `17h30`, `17g30`, `17 gio 30`
 * - `5h sang`, `5h chieu`, `5 gio toi`
 */
export function parseSpecificTimeFromVietnameseText(
  rawText: string,
): SpecificTimeParseResult {
  const normalizedText = normalizeVietnameseText(rawText);
  const timePattern =
    /\b([01]?\d|2[0-3])\s*(?::|h|g|gio)\s*([0-5]\d)?\b/gi;
  const matches = Array.from(normalizedText.matchAll(timePattern));

  if (matches.length === 0) {
    return {
      kind: 'none',
    };
  }

  for (const match of matches) {
    const hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const session = detectTimeSessionAroundMatch(
      normalizedText,
      match.index ?? 0,
      match[0].length,
    );

    if (hour >= 1 && hour <= 11 && !session) {
      return {
        kind: 'ambiguous',
        rawText: match[0].trim(),
        hour,
      };
    }

    return {
      kind: 'time',
      time: formatTime(normalizeHourBySession(hour, session), minute),
      rawText: match[0].trim(),
    };
  }

  return {
    kind: 'none',
  };
}

/**
 * Normalizes parser-provided `specificTime` into `HH:mm` when possible.
 */
export function normalizeSpecificTimeValue(time: string | null) {
  if (!time) {
    return null;
  }

  const parsed = parseSpecificTimeFromVietnameseText(time);

  if (parsed.kind === 'time') {
    return parsed.time;
  }

  return /^\d{2}:\d{2}$/.test(time) ? time : null;
}

function detectTimeSessionAroundMatch(
  normalizedText: string,
  matchIndex: number,
  matchLength: number,
) {
  const context = normalizedText.slice(
    Math.max(0, matchIndex - 24),
    matchIndex + matchLength + 24,
  );

  if (/\b(?:sang som|rang sang|sang)\b/.test(context)) {
    return 'morning';
  }

  if (/\bchieu\b/.test(context)) {
    return 'afternoon';
  }

  if (/\b(?:toi|dem)\b/.test(context)) {
    return 'evening';
  }

  return null;
}

function normalizeHourBySession(
  hour: number,
  session: 'morning' | 'afternoon' | 'evening' | null,
) {
  if (session === 'morning') {
    return hour === 12 ? 0 : hour;
  }

  if (session === 'afternoon' || session === 'evening') {
    return hour >= 1 && hour <= 11 ? hour + 12 : hour;
  }

  return hour;
}

function formatTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeVietnameseText(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
