export type ResolvedAirport = {
  code: string;
  text: string;
};

const AIRPORTS = [
  {
    code: 'HAN',
    text: 'Sân bay Nội Bài (HAN)',
    aliases: ['ha noi', 'hanoi', 'noi bai', 'han'],
  },
  {
    code: 'SGN',
    text: 'Sân bay Tân Sơn Nhất (SGN)',
    aliases: ['sai gon', 'saigon', 'ho chi minh', 'tphcm', 'sgn', 'tan son nhat'],
  },
] as const;

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
 * Resolves a known airport from a free-text phrase.
 *
 * MVP supports HAN and SGN only. New airport support should be added here, not
 * inside Telegram transport or Playwright automation.
 */
export function resolveAirportFromText(value: string): ResolvedAirport | null {
  const normalizedValue = normalizeAirportText(value);
  const airport = AIRPORTS.find((candidate) =>
    candidate.aliases.some((alias) => normalizedValue.includes(alias)),
  );

  if (!airport) {
    return null;
  }

  return {
    code: airport.code,
    text: airport.text,
  };
}
