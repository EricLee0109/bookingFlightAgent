export type AirlineCatalogEntry = {
  code: string;
  name: string;
  aliases: string[];
};

/**
 * Catalog of airlines currently visible in the 1Booking flight result cards.
 *
 * Selection parsing uses this list to turn operator text such as "Vietjet" or
 * "VJ" into a stable airline code before browser automation starts.
 */
export const AIRLINE_CATALOG: AirlineCatalogEntry[] = [
  {
    code: 'VJ',
    name: 'Vietjet Air',
    aliases: ['vietjet', 'viet jet', 'vietjet air', 'vj'],
  },
  {
    code: 'VN',
    name: 'Vietnam Airlines',
    aliases: ['vietnam airlines', 'vietnam airline', 'hang vietnam', 'vn'],
  },
  {
    code: 'QH',
    name: 'Bamboo Airways',
    aliases: ['bamboo', 'bamboo airways', 'qh'],
  },
  {
    code: 'VU',
    name: 'Vietravel Airlines',
    aliases: ['vietravel', 'vietravel airlines', 'vu'],
  },
  {
    code: '9S',
    name: 'Sun Phu Quoc Airways',
    aliases: ['sun phu quoc', 'sun phu quoc airways', 'sun airways', '9s'],
  },
];

/**
 * Resolves airline text from Telegram into the supported airline catalog.
 *
 * This keeps selection matching based on known airline codes instead of passing
 * free-form operator text directly to Playwright.
 */
export function resolveAirlineFromText(rawText: string) {
  const normalizedText = normalizeTextForAirlineLookup(rawText);

  return (
    AIRLINE_CATALOG.find((airline) =>
      airline.aliases.some((alias) =>
        includesAlias(normalizedText, normalizeTextForAirlineLookup(alias)),
      ),
    ) ?? null
  );
}

/**
 * Resolves an airline code or parser-provided brand text to a catalog entry.
 *
 * OpenAI is instructed to return airline codes, but this helper keeps the
 * mapper defensive when a model returns a brand name such as "Vietnam Airlines".
 */
export function resolveAirlineCodeOrText(rawValue: string) {
  const normalizedValue = normalizeTextForAirlineLookup(rawValue);
  const codeMatch = AIRLINE_CATALOG.find(
    (airline) => normalizeTextForAirlineLookup(airline.code) === normalizedValue,
  );

  return codeMatch ?? resolveAirlineFromText(rawValue);
}

/**
 * Normalizes optional preferred airline codes into unique catalog codes.
 */
export function normalizePreferredAirlineCodes(
  rawCodes: string[] | null | undefined,
) {
  if (!rawCodes || rawCodes.length === 0) {
    return null;
  }

  const normalizedCodes = rawCodes
    .map((rawCode) => resolveAirlineCodeOrText(rawCode)?.code ?? null)
    .filter((code): code is string => code !== null);
  const uniqueCodes = Array.from(new Set(normalizedCodes));

  return uniqueCodes.length > 0 ? uniqueCodes : null;
}

/**
 * Returns catalog display names for normalized airline codes.
 */
export function getAirlineNamesByCodes(codes: string[]) {
  return codes
    .map((code) => AIRLINE_CATALOG.find((airline) => airline.code === code)?.name)
    .filter((name): name is string => Boolean(name));
}

function includesAlias(normalizedText: string, normalizedAlias: string) {
  if (/^[a-z0-9]{2,3}$/.test(normalizedAlias)) {
    return new RegExp(`(^|\\W)${escapeRegExp(normalizedAlias)}(\\W|$)`).test(
      normalizedText,
    );
  }

  return normalizedText.includes(normalizedAlias);
}

/**
 * Normalizes airline/operator text for alias matching.
 */
function normalizeTextForAirlineLookup(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

/**
 * Escapes aliases before using them in short-code regular expressions.
 */
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
