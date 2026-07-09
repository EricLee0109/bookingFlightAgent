type TelegramFlightSelectionContext = {
  latestSearchCaseId: string;
  latestOptionsFollowUp?: TelegramFlightOptionsFollowUpContext;
};

const contextsByChatId = new Map<number, TelegramFlightSelectionContext>();

export type TelegramFlightOptionsFollowUpMode = 'normal' | 'cheapest';

export type TelegramFlightOptionsFollowUpContext = {
  latestSearchCaseId: string;
  mode: TelegramFlightOptionsFollowUpMode;
  resultLimit?: 5 | 10;
};

/**
 * Stores the latest search-results case for natural Telegram selection text.
 *
 * This in-memory context lets an operator say `case nay` after receiving flight
 * screenshots. Explicit BK case ids remain available after process restart.
 */
export function setLatestFlightSearchCase(chatId: number, caseId: string) {
  const existingContext = contextsByChatId.get(chatId);
  const nextContext: TelegramFlightSelectionContext = {
    latestSearchCaseId: caseId,
  };

  if (
    existingContext?.latestSearchCaseId === caseId &&
    existingContext.latestOptionsFollowUp
  ) {
    nextContext.latestOptionsFollowUp = existingContext.latestOptionsFollowUp;
  }

  contextsByChatId.set(chatId, nextContext);
}

/**
 * Reads the latest search-results case for one Telegram chat.
 */
export function getLatestFlightSearchCase(chatId: number) {
  return contextsByChatId.get(chatId) ?? null;
}

/**
 * Stores which follow-up menu is active for the latest flight-results case.
 *
 * Bucket-only replies such as `toi` or `sang som` need this small transport
 * context so SakuraBot keeps normal and cheapest reruns separated.
 */
export function setLatestFlightOptionsFollowUpContext(
  chatId: number,
  context: TelegramFlightOptionsFollowUpContext,
) {
  contextsByChatId.set(chatId, {
    latestSearchCaseId: context.latestSearchCaseId,
    latestOptionsFollowUp: context,
  });
}

/**
 * Reads the active follow-up menu context for one Telegram chat.
 */
export function getLatestFlightOptionsFollowUpContext(chatId: number) {
  return contextsByChatId.get(chatId)?.latestOptionsFollowUp ?? null;
}
