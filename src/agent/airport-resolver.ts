import { AIRPORT_CATALOG } from './airport-catalog';

/**
 * Agent helper for resolving airport aliases against the local catalog.
 *
 * This component supports parser and mapper recovery only. Playwright
 * automation should receive canonical airport code/text values after this
 * boundary has already run.
 */

export type ResolvedAirport = {
  code: string;
  text: string;
};

/**
 * Normalizes airport text for mock parser matching.
 *
 * This helper belongs to parser logic only. Browser automation should receive
 * already-resolved airport code/text values.
 */
export function normalizeAirportText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Checks whether free text contains one airport alias safely.
 *
 * Short IATA aliases like `HAN` must match a whole token only. Without this,
 * Vietnamese words such as `thanh` can accidentally match `han`.
 */
function matchesAirportAlias(normalizedValue: string, alias: string) {
  const normalizedAlias = normalizeAirportText(alias);

  if (normalizedAlias.length <= 3) {
    const tokens = normalizedValue.split(/[^a-z0-9]+/).filter(Boolean);

    return tokens.includes(normalizedAlias);
  }

  return normalizedValue.includes(normalizedAlias);
}

/**
 * Resolves a known airport from a free-text phrase.
 *
 * Current OpenAI Telegram production flow does not call this helper directly.
 * It is kept for mock/fallback parsers and alias coverage, where local code may
 * need to infer an airport from raw operator text without AI.
 */
export function resolveAirportFromText(value: string): ResolvedAirport | null {
  const normalizedValue = normalizeAirportText(value);
  const airport = AIRPORT_CATALOG.find((candidate) =>
    candidate.aliases.some((alias: string) => matchesAirportAlias(normalizedValue, alias)),
  );

  if (!airport) {
    return null;
  }

  return {
    code: airport.code,
    text: airport.text,
  };
}

/**
 * Resolves a known airport by IATA code.
 *
 * This keeps automation input using our canonical 1Booking airport text instead
 * of trusting AI-generated display labels.
 */
export function resolveAirportByCode(code: string): ResolvedAirport | null {
  const normalizedCode = code.trim().toUpperCase();
  const airport = AIRPORT_CATALOG.find(
    (candidate) => candidate.code === normalizedCode,
  );

  if (!airport) {
    return null;
  }

  return {
    code: airport.code,
    text: airport.text,
  };
}
