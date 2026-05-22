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
