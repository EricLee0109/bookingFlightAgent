import {
  ParsedPassengerMessageSchema,
  type ParsedPassengerMessage,
  type PassengerMention,
} from '../contracts/passenger';

const BOOKING_CASE_PATTERN = /\bBK-\d{8}-\d{6}\b/i;
const HONORIFIC_PATTERN =
  /^(chị|chi|anh|cô|co|chú|chu|bác|bac|em|bé|be|ông|ong|bà|ba)(?=\s|$)/iu;
const FEMALE_HONORIFICS = new Set(['CHI', 'CO', 'BA']);
const MALE_HONORIFICS = new Set(['ANH', 'CHU', 'ONG']);

/**
 * Parses the common passenger message shapes without an external AI request.
 *
 * Unknown free-form wording returns null so the OpenAI parser remains the
 * fallback. Local SQLite still owns final passenger identity resolution.
 */
export function parseDeterministicPassengerMessage(
  rawMessage: string,
): ParsedPassengerMessage | null {
  const text = rawMessage.trim();

  if (!text) {
    return null;
  }

  const caseCode = text.match(BOOKING_CASE_PATTERN)?.[0]?.toUpperCase() ?? null;
  const dob = extractPassengerDob(text);
  const quickInput = text.match(/^\s*(Nữ|Nu|Nam)\s*,?\s+(.+?)\s*$/iu);

  if (quickInput) {
    const fullName = cleanPassengerName(quickInput[2]);

    if (isPassengerName(fullName)) {
      return buildParsedPassengerMessage(
        'provide_new_passenger',
        caseCode,
        {
          fullName,
          gender: normalizePassengerGender(quickInput[1]),
          dob,
        },
      );
    }
  }

  const actionName = extractPassengerNameAfterAction(text);

  if (actionName) {
    return buildParsedPassengerMessage('attach_passenger', caseCode, {
      fullName: actionName,
      gender: inferGenderFromHonorific(actionName),
      dob,
    });
  }

  const withoutCaseCode = cleanPassengerName(
    text.replace(BOOKING_CASE_PATTERN, ''),
  );

  if (
    HONORIFIC_PATTERN.test(withoutCaseCode) &&
    isPassengerName(withoutCaseCode)
  ) {
    return buildParsedPassengerMessage('attach_passenger', caseCode, {
      fullName: withoutCaseCode,
      gender: inferGenderFromHonorific(withoutCaseCode),
      dob,
    });
  }

  if (isStandalonePassengerName(withoutCaseCode)) {
    return buildParsedPassengerMessage('provide_new_passenger', caseCode, {
      fullName: withoutCaseCode,
      gender: null,
      dob,
    });
  }

  const standaloneGender = normalizePassengerGender(withoutCaseCode);

  if (standaloneGender) {
    return buildParsedPassengerMessage('update_passenger_fields', caseCode, {
      fullName: null,
      gender: standaloneGender,
      dob,
    });
  }

  if (dob) {
    return buildParsedPassengerMessage('update_passenger_fields', caseCode, {
      fullName: null,
      gender: null,
      dob,
    });
  }

  return null;
}

function buildParsedPassengerMessage(
  intent: ParsedPassengerMessage['intent'],
  caseCode: string | null,
  mention: PassengerMention,
) {
  return ParsedPassengerMessageSchema.parse({
    intent,
    caseCode,
    passengerMentions: [mention],
    missingFields: [],
    confidence: 1,
  });
}

function extractPassengerNameAfterAction(rawMessage: string) {
  const match = rawMessage.match(
    /(?:^|\s)(?:cho|lấy|lay|dùng|dung)\s+(.+?)\s*$/iu,
  );

  if (!match) {
    return null;
  }

  const candidate = cleanPassengerName(match[1]);

  if (HONORIFIC_PATTERN.test(candidate) && isPassengerName(candidate)) {
    return candidate;
  }

  return isStandalonePassengerName(candidate) ? candidate : null;
}

function cleanPassengerName(value: string) {
  return value
    .replace(
      /,?\s*(?:ngày\s+sinh|ngay\s+sinh|sinh)\s+\d{1,2}[/.=-]\d{1,2}[/.=-]\d{4}.*$/iu,
      '',
    )
    .replace(/[,.!?;:]+$/u, '')
    .replace(/\s+(?:nhé|nhe|nha|ạ)$/iu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function isPassengerName(value: string) {
  const tokens = value.split(/\s+/).filter(Boolean);

  return (
    tokens.length >= 2 &&
    tokens.length <= 6 &&
    tokens.every((token) => /^[\p{L}'-]+$/u.test(token))
  );
}

function isStandalonePassengerName(value: string) {
  const tokens = value.split(/\s+/).filter(Boolean);

  return (
    isPassengerName(value) &&
    tokens.every((token) => /^\p{Lu}/u.test(token))
  );
}

function inferGenderFromHonorific(
  fullName: string,
): PassengerMention['gender'] {
  const honorific = fullName.match(HONORIFIC_PATTERN)?.[1];

  if (!honorific) {
    return null;
  }

  const normalized = normalizePassengerToken(honorific);

  if (FEMALE_HONORIFICS.has(normalized)) {
    return 'female';
  }

  if (MALE_HONORIFICS.has(normalized)) {
    return 'male';
  }

  return null;
}

function normalizePassengerGender(
  value: string,
): PassengerMention['gender'] {
  const normalized = normalizePassengerToken(value);

  if (normalized === 'NU') {
    return 'female';
  }

  if (normalized === 'NAM') {
    return 'male';
  }

  return null;
}

function normalizePassengerToken(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase();
}

function extractPassengerDob(rawMessage: string) {
  const match = rawMessage.match(
    /(?:ngày\s+sinh|ngay\s+sinh|sinh)\s+(\d{1,2})[/.=-](\d{1,2})[/.=-](\d{4})/iu,
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    year.toString().padStart(4, '0'),
    month.toString().padStart(2, '0'),
    day.toString().padStart(2, '0'),
  ].join('-');
}
