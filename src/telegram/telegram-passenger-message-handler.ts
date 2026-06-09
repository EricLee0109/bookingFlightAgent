import TelegramBot from 'node-telegram-bot-api';
import { createOpenAIPassengerMessageParser } from '../agent/openai-passenger-message-parser';
import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';
import { PassengerStore } from '../passengers/passenger-store';
import {
  type PassengerProfile,
} from '../passengers/passenger-types';
import { type PassengerMention } from '../contracts/passenger';
import {
  PassengerResolutionService,
  type PassengerMentionResolutionResult,
} from '../services/passenger-resolution-service';
import { fillPassengerAndHoldOneBookingCase } from '../services/passenger-hold-automation-service';
import {
  readLocalFlightCase,
  updateLocalFlightCase,
} from '../storage/local-case-store';
import { isAllowedTelegramOperator } from './telegram-access';
import {
  formatPassengerAmbiguousMessage,
  formatPassengerAttachedMessage,
  formatPassengerCaseRequiredMessage,
  formatPassengerCaseNotReadyMessage,
  formatPassengerHoldFailedMessage,
  formatPassengerHoldMissingDobMessage,
  formatPassengerHoldNeedsReviewMessage,
  formatPassengerHoldRunningMessage,
  formatPassengerHoldSuccessMessage,
  formatPassengerMatchedMessage,
  formatPassengerMissingFieldsMessage,
  formatNewPassengerMissingFieldsMessage,
  formatOneBookingAuthRefreshStartedMessage,
  formatPassengerMentionMissingMessage,
  formatPassengerNotFoundMessage,
  formatPassengerParserFailedMessage,
  formatPassengerProfileMissingMessage,
} from './telegram-formatters';
import {
  clearPendingPassengerProfiles,
  getTelegramPassengerContext,
  setActivePassengerCase,
  setPendingPassengerProfiles,
} from './telegram-passenger-context';
import {
  buildPassengerCandidateKeyboard,
  buildPassengerConfirmationKeyboard,
  parsePassengerCallbackData,
} from './telegram-passenger-keyboards';

type LocalPassengerReadyCase = NonNullable<
  Awaited<ReturnType<typeof readLocalFlightCase>>
>;

export type TelegramPassengerResolutionOutcome =
  | {
      status: 'not_attempted';
      flightCase: LocalPassengerReadyCase;
    }
  | {
      status: 'parser_failed';
      flightCase: LocalPassengerReadyCase;
      message: string;
    }
  | {
      status: 'no_mention';
      flightCase: LocalPassengerReadyCase;
      intent: string;
    }
  | {
      status: 'ready';
      flightCase: LocalPassengerReadyCase;
      profile: PassengerProfile;
    }
  | {
      status: 'resolved';
      flightCase: LocalPassengerReadyCase;
      result: PassengerMentionResolutionResult;
    };

export type ResolvePassengerMessageForCaseOptions = {
  autoConfirmReadyPassenger?: boolean;
  pendingPassengerProfileIds?: number[];
};

/**
 * Telegram passenger conversation component.
 *
 * Responsibilities:
 * - Route natural passenger messages after flight selection.
 * - Call the passenger AI parser and local SQLite resolution service.
 * - Render local resolver outcomes and inline buttons.
 * - Attach a confirmed ready profile to local case memory.
 * - Trigger the separated Playwright fill-and-hold service.
 */

/**
 * Handles Telegram inline-button callbacks for local passenger candidates.
 */
export async function handleTelegramCallbackQuery(
  bot: TelegramBot,
  callbackQuery: TelegramBot.CallbackQuery,
) {
  const telegramUserId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat.id;
  const payload = callbackQuery.data
    ? parsePassengerCallbackData(callbackQuery.data)
    : null;

  if (!chatId || !payload) {
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id);

  if (!isAllowedTelegramOperator(telegramUserId)) {
    await bot.sendMessage(chatId, 'Bạn chưa có quyền sử dụng Agent này nhé.');
    return;
  }

  const existingCase = await readLocalFlightCase(payload.caseId);

  if (!existingCase) {
    await bot.sendMessage(chatId, `Mình chưa tìm thấy case ${payload.caseId}. Bạn kiểm tra lại mã case giúp mình nhé.`);
    return;
  }

  await withPassengerResolutionService(async (service) => {
    const profile = service.getProfile(payload.passengerProfileId);

    if (!profile) {
      await bot.sendMessage(chatId, formatPassengerProfileMissingMessage());
      return;
    }

    setActivePassengerCase(chatId, existingCase.caseId);

    if (payload.action === 'choose') {
      await renderChosenPassengerCandidate(
        bot,
        chatId,
        existingCase,
        service,
        profile,
      );
      return;
    }

    await attachConfirmedPassenger(bot, chatId, existingCase, service, profile);
  });
}

/**
 * Routes natural passenger messages only when a passenger-ready case exists.
 *
 * This prevents passenger text from falling through to flight-search parsing,
 * while keeping route search messages on the original search parser path.
 */
export async function tryHandleTelegramPassengerMessage(
  bot: TelegramBot,
  chatId: number,
  rawMessage: string,
) {
  const explicitCaseId = rawMessage.match(BOOKING_CASE_REGEX)?.[0]?.toUpperCase();
  const context = getTelegramPassengerContext(chatId);
  const caseId = explicitCaseId ?? context?.activeCaseId;

  if (!caseId) {
    if (messageLooksLikePassengerInfo(rawMessage)) {
      await bot.sendMessage(chatId, formatPassengerCaseRequiredMessage());
      return true;
    }

    return false;
  }

  const existingCase = await readLocalFlightCase(caseId);

  if (!existingCase || !isPassengerReadyCaseStatus(existingCase.status)) {
    if (explicitCaseId && messageLooksLikePassengerInfo(rawMessage)) {
      await bot.sendMessage(
        chatId,
        formatPassengerCaseNotReadyMessage(caseId),
      );
      return true;
    }

    return false;
  }

  setActivePassengerCase(chatId, caseId);

  const outcome = await resolvePassengerMessageForCase(
    rawMessage,
    existingCase,
    {
      pendingPassengerProfileIds: context?.pendingPassengerProfileIds,
    },
  );

  await renderPassengerResolutionOutcome(bot, chatId, outcome, {
    holdWhenReady: true,
  });

  return true;
}

/**
 * Parses and resolves one passenger message against a known local case.
 *
 * This helper is shared by passenger-only Telegram messages and by the combined
 * select-flight + passenger flow. It updates local case memory but does not send
 * Telegram messages or run Playwright by itself.
 */
export async function resolvePassengerMessageForCase(
  rawMessage: string,
  existingCase: LocalPassengerReadyCase,
  options: ResolvePassengerMessageForCaseOptions = {},
): Promise<TelegramPassengerResolutionOutcome> {
  if (!messageLooksLikePassengerInfo(rawMessage)) {
    return {
      status: 'not_attempted',
      flightCase: existingCase,
    };
  }

  let parsedPassengerMessage;

  try {
    const parser = createOpenAIPassengerMessageParser();
    parsedPassengerMessage = await parser.parse(rawMessage);
  } catch (error) {
    const currentCase = await updateLocalFlightCase(existingCase, {
      status: 'PASSENGER_INFO_FAILED',
      passengerErrorMessage:
        error instanceof Error ? error.message : 'Passenger parser failed.',
    });

    return {
      status: 'parser_failed',
      flightCase: currentCase,
      message:
        error instanceof Error ? error.message : 'Passenger parser failed.',
    };
  }

  const previousPassengerMention =
    existingCase.parsedPassengerMessage?.passengerMentions[0];
  const pendingProfileIds = options.pendingPassengerProfileIds ?? [];

  let currentCase = await updateLocalFlightCase(existingCase, {
    status: 'PASSENGER_INFO_RECEIVED',
    parsedPassengerMessage,
  });
  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'PASSENGER_INFO_PARSED',
  });

  if (parsedPassengerMessage.intent === 'confirm_passenger') {
    return await withPassengerResolutionService(async (service) => {
      const profile =
        pendingProfileIds.length === 1
          ? service.getProfile(pendingProfileIds[0])
          : null;

      if (!profile) {
        return {
          status: 'no_mention',
          flightCase: currentCase,
          intent: parsedPassengerMessage.intent,
        } satisfies TelegramPassengerResolutionOutcome;
      }

      const updatedCase = await attachPassengerToCaseMemory(
        currentCase,
        service,
        profile,
      );

      return {
        status: 'ready',
        flightCase: updatedCase,
        profile,
      } satisfies TelegramPassengerResolutionOutcome;
    });
  }

  const mention = parsedPassengerMessage.passengerMentions[0];

  if (!mention) {
    return {
      status: 'no_mention',
      flightCase: currentCase,
      intent: parsedPassengerMessage.intent,
    };
  }

  const shouldMergeMention = shouldMergePassengerFollowUp(
    existingCase.status,
    parsedPassengerMessage.intent,
    previousPassengerMention,
  );
  const effectiveMention = shouldMergeMention
    ? mergePassengerMentions(previousPassengerMention, mention)
    : mention;

  if (effectiveMention !== mention) {
    parsedPassengerMessage = {
      ...parsedPassengerMessage,
      passengerMentions: [
        effectiveMention,
        ...parsedPassengerMessage.passengerMentions.slice(1),
      ],
    };
    currentCase = await updateLocalFlightCase(currentCase, {
      parsedPassengerMessage,
    });
  }

  return await withPassengerResolutionService(async (service) => {
    const result = service.resolveMention(effectiveMention, {
      caseId: currentCase.caseId,
      excludeProfileIds:
        parsedPassengerMessage.intent === 'reject_passenger'
          ? pendingProfileIds
          : undefined,
      pendingPassengerProfileId:
        shouldMergeMention &&
        pendingProfileIds.length === 1
          ? pendingProfileIds[0]
          : undefined,
    });

    if (
      options.autoConfirmReadyPassenger &&
      result.status === 'matched' &&
      result.missingFields.length === 0
    ) {
      const updatedCase = await attachPassengerToCaseMemory(
        currentCase,
        service,
        result.profile,
      );

      return {
        status: 'ready',
        flightCase: updatedCase,
        profile: result.profile,
      } satisfies TelegramPassengerResolutionOutcome;
    }

    if (result.status === 'passenger_ready') {
      const updatedCase = await updateLocalFlightCase(currentCase, {
        status: 'PASSENGER_INFO_CONFIRMED',
        attachedPassenger: result.profile,
        attachedPassengerInfo: result.passengerInfo,
        passengerErrorMessage: undefined,
      });

      return {
        status: 'ready',
        flightCase: updatedCase,
        profile: result.profile,
      } satisfies TelegramPassengerResolutionOutcome;
    }

    if (
      parsedPassengerMessage.intent === 'update_passenger_fields' &&
      result.status === 'matched' &&
      currentCase.attachedPassenger?.id === result.profile.id
    ) {
      const updatedCase = await attachPassengerToCaseMemory(
        currentCase,
        service,
        result.profile,
      );

      return {
        status: 'ready',
        flightCase: updatedCase,
        profile: result.profile,
      } satisfies TelegramPassengerResolutionOutcome;
    }

    return {
      status: 'resolved',
      flightCase: currentCase,
      result,
    } satisfies TelegramPassengerResolutionOutcome;
  });
}

/**
 * Merges a quick follow-up answer with the previous passenger draft.
 *
 * Example: after the bot asks for gender, the operator can answer without
 * repeating a previously supplied full name.
 */
export function mergePassengerMentions(
  previousMention: PassengerMention | undefined,
  nextMention: PassengerMention,
) {
  if (!previousMention) {
    return nextMention;
  }

  return {
    fullName: chooseMergedPassengerFullName(previousMention, nextMention),
    gender: nextMention.gender ?? previousMention.gender,
    dob: nextMention.dob ?? previousMention.dob,
  };
}

/**
 * Renders a passenger resolution outcome and optionally starts hold automation.
 */
export async function renderPassengerResolutionOutcome(
  bot: TelegramBot,
  chatId: number,
  outcome: TelegramPassengerResolutionOutcome,
  options: {
    holdWhenReady: boolean;
  },
) {
  if (outcome.status === 'not_attempted') {
    return;
  }

  if (outcome.status === 'parser_failed') {
    await bot.sendMessage(chatId, formatPassengerParserFailedMessage());
    return;
  }

  if (outcome.status === 'no_mention') {
    await bot.sendMessage(
      chatId,
      formatPassengerMentionMissingMessage(outcome.intent === 'reject_passenger'),
    );
    return;
  }

  if (outcome.status === 'ready') {
    setPendingPassengerProfiles(chatId, outcome.flightCase.caseId, [
      outcome.profile.id,
    ]);
    await bot.sendMessage(
      chatId,
      formatPassengerAttachedMessage(outcome.flightCase.caseId, outcome.profile),
    );

    if (options.holdWhenReady) {
      await runAutomaticPassengerHold(bot, chatId, outcome.flightCase);
    }

    return;
  }

  await withPassengerResolutionService(async (service) => {
    await renderPassengerResolution(
      bot,
      chatId,
      outcome.flightCase,
      service,
      outcome.result,
      options,
    );
  });
}

/**
 * Decides whether a short passenger reply should enrich the previous draft.
 */
function shouldMergePassengerFollowUp(
  caseStatus: string,
  intent: string,
  previousMention: PassengerMention | undefined,
) {
  if (!previousMention) {
    return false;
  }

  if (intent === 'update_passenger_fields') {
    return true;
  }

  return (
    caseStatus === 'PASSENGER_INFO_NEEDS_REVIEW' &&
    (intent === 'attach_passenger' || intent === 'provide_new_passenger')
  );
}

/**
 * Keeps a complete full name from being overwritten by a later nickname reply.
 */
function chooseMergedPassengerFullName(
  previousMention: PassengerMention,
  nextMention: PassengerMention,
) {
  if (!nextMention.fullName) {
    return previousMention.fullName;
  }

  if (
    isCompletePassengerName(previousMention.fullName) &&
    !isCompletePassengerName(nextMention.fullName)
  ) {
    return previousMention.fullName;
  }

  return nextMention.fullName;
}

function isCompletePassengerName(fullName: string | null) {
  return (fullName?.trim().split(/\s+/).filter(Boolean).length ?? 0) >= 2;
}

/**
 * Renders local resolver outcomes as natural Telegram messages and buttons.
 */
async function renderPassengerResolution(
  bot: TelegramBot,
  chatId: number,
  flightCase: LocalPassengerReadyCase,
  service: PassengerResolutionService,
  result: PassengerMentionResolutionResult,
  options: {
    holdWhenReady: boolean;
  } = {
    holdWhenReady: true,
  },
) {
  if (result.status === 'new_passenger_missing_fields') {
    clearPendingPassengerProfiles(chatId);
    await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_NEEDS_REVIEW',
      passengerErrorMessage: `Missing new passenger fields: ${result.missingFields.join(', ')}`,
    });
    await bot.sendMessage(
      chatId,
      formatNewPassengerMissingFieldsMessage(
        result.missingFields,
        result.mention,
      ),
    );
    return;
  }

  if (result.status === 'passenger_ready') {
    setPendingPassengerProfiles(chatId, flightCase.caseId, [result.profile.id]);
    const updatedCase = await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_CONFIRMED',
      attachedPassenger: result.profile,
      attachedPassengerInfo: result.passengerInfo,
      passengerErrorMessage: undefined,
    });
    await bot.sendMessage(
      chatId,
      formatPassengerAttachedMessage(flightCase.caseId, result.profile),
    );
    if (options.holdWhenReady) {
      await runAutomaticPassengerHold(bot, chatId, updatedCase);
    }
    return;
  }

  if (result.status === 'not_found') {
    clearPendingPassengerProfiles(chatId);
    await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_NEEDS_REVIEW',
      passengerErrorMessage: 'Passenger profile not found in local cache.',
    });
    await bot.sendMessage(chatId, formatPassengerNotFoundMessage());
    return;
  }

  if (result.status === 'ambiguous') {
    setPendingPassengerProfiles(
      chatId,
      flightCase.caseId,
      result.candidates.map((profile) => profile.id),
    );
    await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_NEEDS_REVIEW',
      passengerErrorMessage: 'Passenger profile match is ambiguous.',
    });
    await bot.sendMessage(
      chatId,
      formatPassengerAmbiguousMessage(result.candidates.length),
      {
        reply_markup: buildPassengerCandidateKeyboard(
          flightCase.caseId,
          result.candidates,
        ),
      },
    );
    return;
  }

  setPendingPassengerProfiles(chatId, flightCase.caseId, [result.profile.id]);

  if (result.status === 'matched_but_missing_fields') {
    await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_NEEDS_REVIEW',
      passengerErrorMessage: `Missing passenger fields: ${result.missingFields.join(', ')}`,
    });
    await bot.sendMessage(
      chatId,
      formatPassengerMissingFieldsMessage(result.profile, result.missingFields),
    );
    return;
  }

  await renderChosenPassengerCandidate(
    bot,
    chatId,
    flightCase,
    service,
    result.profile,
  );
}

/**
 * Shows a chosen candidate or requests its remaining required fields.
 */
async function renderChosenPassengerCandidate(
  bot: TelegramBot,
  chatId: number,
  flightCase: LocalPassengerReadyCase,
  service: PassengerResolutionService,
  profile: PassengerProfile,
) {
  const missingFields = service.getMissingFields(profile);

  setPendingPassengerProfiles(chatId, flightCase.caseId, [profile.id]);

  if (missingFields.length > 0) {
    await updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_NEEDS_REVIEW',
      passengerErrorMessage: `Missing passenger fields: ${missingFields.join(', ')}`,
    });
    await bot.sendMessage(
      chatId,
      formatPassengerMissingFieldsMessage(profile, missingFields),
    );
    return;
  }

  await updateLocalFlightCase(flightCase, {
    status: 'PASSENGER_INFO_NEEDS_REVIEW',
    passengerErrorMessage: undefined,
  });
  await bot.sendMessage(chatId, formatPassengerMatchedMessage(profile), {
    reply_markup: buildPassengerConfirmationKeyboard(flightCase.caseId, profile),
  });
}

/**
 * Attaches a confirmed ready passenger and starts separated hold automation.
 */
async function attachConfirmedPassenger(
  bot: TelegramBot,
  chatId: number,
  flightCase: LocalPassengerReadyCase,
  service: PassengerResolutionService,
  profile: PassengerProfile,
) {
  const missingFields = service.getMissingFields(profile);

  if (missingFields.length > 0) {
    await bot.sendMessage(
      chatId,
      formatPassengerMissingFieldsMessage(profile, missingFields),
    );
    return;
  }

  const updatedCase = await attachPassengerToCaseMemory(
    flightCase,
    service,
    profile,
  );
  setPendingPassengerProfiles(chatId, flightCase.caseId, [profile.id]);
  await bot.sendMessage(
    chatId,
    formatPassengerAttachedMessage(flightCase.caseId, profile),
  );
  await runAutomaticPassengerHold(bot, chatId, updatedCase);
}

/**
 * Persists a ready passenger on local case memory and SQLite case_passengers.
 *
 * This helper intentionally does not send Telegram messages or start browser
 * automation, so combined selection/passenger flows can decide when to hold.
 */
async function attachPassengerToCaseMemory(
  flightCase: LocalPassengerReadyCase,
  service: PassengerResolutionService,
  profile: PassengerProfile,
) {
  return await updateLocalFlightCase(flightCase, {
    status: 'PASSENGER_INFO_CONFIRMED',
    attachedPassenger: profile,
    attachedPassengerInfo: service.attachPassengerToCase(
      flightCase.caseId,
      profile,
    ).passengerInfo,
    passengerErrorMessage: undefined,
  });
}

/**
 * Runs automatic passenger fill and hold after both flight and passenger exist.
 *
 * Success sends text only. Error screenshots remain enabled for local support.
 */
export async function runAutomaticPassengerHold(
  bot: TelegramBot,
  chatId: number,
  flightCase: LocalPassengerReadyCase,
  options: {
    skipProgressMessage?: boolean;
  } = {},
) {
  if (!options.skipProgressMessage) {
    await bot.sendMessage(
      chatId,
      formatPassengerHoldRunningMessage(flightCase.caseId),
    );
  }

  const result = await fillPassengerAndHoldOneBookingCase(flightCase.caseId, {
    onAuthRefresh: () =>
      Promise.resolve(void bot.sendMessage(chatId, formatOneBookingAuthRefreshStartedMessage())),
  });

  if (result.ok) {
    clearPendingPassengerProfiles(chatId);
    await bot.sendMessage(
      chatId,
      formatPassengerHoldSuccessMessage(
        flightCase.caseId,
        result.pnrCode,
        result.pnrWarning,
      ),
    );
    return;
  }

  if (result.reason === 'needs_input') {
    const profile = flightCase.attachedPassenger;

    if (profile) {
      setPendingPassengerProfiles(chatId, flightCase.caseId, [profile.id]);
      await bot.sendMessage(chatId, formatPassengerHoldMissingDobMessage(profile));
      return;
    }
  }

  if (result.reason === 'needs_review') {
    await bot.sendMessage(
      chatId,
      formatPassengerHoldNeedsReviewMessage(result.message),
    );

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot trạng thái giữ chỗ để bạn kiểm tra thủ công nhé.',
      });
    }

    return;
  }

  await bot.sendMessage(chatId, formatPassengerHoldFailedMessage(result.message));

  if (result.errorScreenshotPath) {
    await bot.sendPhoto(chatId, result.errorScreenshotPath, {
      caption: 'Screenshot để mình cùng đối chiếu lỗi nhập thông tin và giữ chỗ.',
    });
  }
}

async function withPassengerResolutionService<T>(
  callback: (service: PassengerResolutionService) => Promise<T>,
) {
  const store = new PassengerStore();

  try {
    return await callback(new PassengerResolutionService(store));
  } finally {
    store.close();
  }
}

function isPassengerReadyCaseStatus(status: string) {
  return new Set([
    'AWAITING_PASSENGER_INFO',
    'PASSENGER_INFO_RECEIVED',
    'PASSENGER_INFO_PARSED',
    'PASSENGER_INFO_NEEDS_REVIEW',
    'PASSENGER_INFO_FAILED',
    'FILL_PASSENGER_FAILED',
    'HOLD_FAILED',
  ]).has(status);
}

/**
 * Detects whether a Telegram message contains passenger information.
 */
export function messageLooksLikePassengerInfo(rawMessage: string) {
  const honorific =
    '(?:chị|chi|anh|cô|co|chú|chu|bác|bac|em|bé|be|khách|khach)(?=\\s|$)';

  return new RegExp(
    [
      `(?:dùng|dung|lấy|lay)\\s+${honorific}`,
      `(?:cho|khách|khach)\\s+${honorific}`,
      'khách\\s+là',
      'khach\\s+la',
      'sinh\\s+\\d',
      'không\\s+phải\\s+khách',
      'khong\\s+phai\\s+khach',
      'đúng\\s+rồi\\s+dùng\\s+khách',
      'dung\\s+khach',
    ].join('|'),
    'i',
  ).test(
    rawMessage,
  );
}
