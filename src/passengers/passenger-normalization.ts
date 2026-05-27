/**
 * Normalizes passenger names and operator queries for matching.
 *
 * The resolver uses uppercase unaccented text so Vietnamese input like
 * "chi Lanh" can match a stored 1Booking passenger named "NGUYEN THI LANH".
 */
export function normalizePassengerText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Joins last name and first name using 1Booking's passenger naming shape.
 */
export function buildPassengerFullName(lastName: string, firstName: string) {
  return normalizePassengerText([lastName, firstName].filter(Boolean).join(' '));
}

/**
 * Sanitizes the short query stored in confidence evidence.
 *
 * This keeps only normalized matching text instead of storing full Telegram
 * messages that may contain unrelated customer context.
 */
export function sanitizeObservedPassengerQuery(rawQuery: string) {
  return normalizePassengerText(rawQuery).slice(0, 120);
}
