type TelegramPassengerContext = {
  activeCaseId: string;
  pendingPassengerProfileIds: number[];
};

const contextsByChatId = new Map<number, TelegramPassengerContext>();

/**
 * Stores lightweight passenger conversation context for Telegram long polling.
 *
 * This is intentionally in-memory for the lean local MVP. Explicit BK case ids
 * still work after restart, while phrases such as `case nay` require the active
 * polling process to retain the chat context.
 */
export function setActivePassengerCase(chatId: number, caseId: string) {
  contextsByChatId.set(chatId, {
    activeCaseId: caseId,
    pendingPassengerProfileIds: [],
  });
}

/**
 * Reads passenger conversation context for one Telegram chat.
 */
export function getTelegramPassengerContext(chatId: number) {
  return contextsByChatId.get(chatId) ?? null;
}

/**
 * Stores candidates currently waiting for an operator decision.
 */
export function setPendingPassengerProfiles(
  chatId: number,
  caseId: string,
  profileIds: number[],
) {
  contextsByChatId.set(chatId, {
    activeCaseId: caseId,
    pendingPassengerProfileIds: profileIds,
  });
}

/**
 * Clears pending candidates while preserving the active booking case.
 */
export function clearPendingPassengerProfiles(chatId: number) {
  const context = contextsByChatId.get(chatId);

  if (context) {
    contextsByChatId.set(chatId, {
      ...context,
      pendingPassengerProfileIds: [],
    });
  }
}
