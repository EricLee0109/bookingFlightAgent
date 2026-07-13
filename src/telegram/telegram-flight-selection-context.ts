type TelegramFlightSelectionContext = {
  latestSearchCaseId: string;
  latestOptionsFollowUp?: TelegramFlightOptionsFollowUpContext;
  pendingSpecificTimeClarification?: TelegramSpecificTimeClarificationContext;
};

const contextsByChatId = new Map<number, TelegramFlightSelectionContext>();

export type TelegramFlightOptionsFollowUpMode = 'normal' | 'cheapest';

export type TelegramFlightOptionsFollowUpContext = {
  latestSearchCaseId: string;
  mode: TelegramFlightOptionsFollowUpMode;
  resultLimit?: 5 | 10;
};

export type TelegramSpecificTimeClarificationContext = {
  caseId: string;
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

  if (
    existingContext?.latestSearchCaseId === caseId &&
    existingContext.pendingSpecificTimeClarification
  ) {
    nextContext.pendingSpecificTimeClarification =
      existingContext.pendingSpecificTimeClarification;
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

/**
 * Stores that the latest parsed flight search is waiting for a clearer time.
 */
export function setPendingSpecificTimeClarification(
  chatId: number,
  context: TelegramSpecificTimeClarificationContext,
) {
  const existingContext = contextsByChatId.get(chatId);

  contextsByChatId.set(chatId, {
    latestSearchCaseId: existingContext?.latestSearchCaseId ?? context.caseId,
    latestOptionsFollowUp: existingContext?.latestOptionsFollowUp,
    pendingSpecificTimeClarification: context,
  });
}

/**
 * Reads the pending specific-time clarification context for one chat.
 */
export function getPendingSpecificTimeClarification(chatId: number) {
  return contextsByChatId.get(chatId)?.pendingSpecificTimeClarification ?? null;
}

/**
 * Clears the pending specific-time clarification context for one chat.
 */
export function clearPendingSpecificTimeClarification(chatId: number) {
  const existingContext = contextsByChatId.get(chatId);

  if (!existingContext) {
    return;
  }

  contextsByChatId.set(chatId, {
    latestSearchCaseId: existingContext.latestSearchCaseId,
    latestOptionsFollowUp: existingContext.latestOptionsFollowUp,
  });
}
