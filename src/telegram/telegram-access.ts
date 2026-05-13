/**
 * Checks whether a Telegram user is allowed to use the internal Agent.
 *
 * MVP security rule:
 * - Only Telegram user IDs listed in TELEGRAM_OPERATOR_IDS can trigger automation.
 * - This prevents random Telegram users from using the bot if they find it.
 */
export function isAllowedTelegramOperator(telegramUserId: number) {
  const rawIds = process.env.TELEGRAM_OPERATOR_IDS ?? '';

  const allowedIds = rawIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return allowedIds.includes(String(telegramUserId));
}
