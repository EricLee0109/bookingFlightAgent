type TelegramFlightSelectionContext = {
  latestSearchCaseId: string;
};

const contextsByChatId = new Map<number, TelegramFlightSelectionContext>();

/**
 * Stores the latest search-results case for natural Telegram selection text.
 *
 * This in-memory context lets an operator say `case nay` after receiving flight
 * screenshots. Explicit BK case ids remain available after process restart.
 */
export function setLatestFlightSearchCase(chatId: number, caseId: string) {
  contextsByChatId.set(chatId, {
    latestSearchCaseId: caseId,
  });
}

/**
 * Reads the latest search-results case for one Telegram chat.
 */
export function getLatestFlightSearchCase(chatId: number) {
  return contextsByChatId.get(chatId) ?? null;
}
