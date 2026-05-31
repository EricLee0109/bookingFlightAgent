import TelegramBot from 'node-telegram-bot-api';
import { createOpenAIPassengerMessageParser } from '../agent/openai-passenger-message-parser';
import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';
import { PassengerStore } from '../passengers/passenger-store';
import {
  type PassengerProfile,
  type PassengerResolveResult,
} from '../passengers/passenger-types';
import { PassengerResolutionService } from '../services/passenger-resolution-service';
import {
  readLocalFlightCase,
  updateLocalFlightCase,
} from '../storage/local-case-store';
import { isAllowedTelegramOperator } from './telegram-access';
import {
  formatPassengerAmbiguousMessage,
  formatPassengerAttachedMessage,
  formatPassengerCaseRequiredMessage,
  formatPassengerMatchedMessage,
  formatPassengerMissingFieldsMessage,
  formatPassengerNotFoundMessage,
  formatPassengerParserFailedMessage,
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

/**
 * Telegram passenger conversation component.
 *
 * Responsibilities:
 * - Route natural passenger messages after flight selection.
 * - Call the passenger AI parser and local SQLite resolution service.
 * - Render local resolver outcomes and inline buttons.
 * - Attach a confirmed ready profile to local case memory.
 *
 * This component intentionally stops before Playwright passenger form fill.
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
    await bot.sendMessage(chatId, 'Bạn không có quyền sử dụng Agent này.');
    return;
  }

  const existingCase = await readLocalFlightCase(payload.caseId);

  if (!existingCase) {
    await bot.sendMessage(chatId, `Không tìm thấy case ${payload.caseId}.`);
    return;
  }

  await withPassengerResolutionService(async (service) => {
    const profile = service.getProfile(payload.passengerProfileId);

    if (!profile) {
      await bot.sendMessage(chatId, 'Không tìm thấy passenger profile local.');
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
    if (looksLikePassengerMessage(rawMessage)) {
      await bot.sendMessage(chatId, formatPassengerCaseRequiredMessage());
      return true;
    }

    return false;
  }

  const existingCase = await readLocalFlightCase(caseId);

  if (!existingCase || !isPassengerReadyCaseStatus(existingCase.status)) {
    if (explicitCaseId && looksLikePassengerMessage(rawMessage)) {
      await bot.sendMessage(
        chatId,
        `Case ${caseId} chưa sẵn sàng để nhận thông tin khách.`,
      );
      return true;
    }

    return false;
  }

  setActivePassengerCase(chatId, caseId);

  let parsedPassengerMessage;

  try {
    const parser = createOpenAIPassengerMessageParser();
    parsedPassengerMessage = await parser.parse(rawMessage);
  } catch (error) {
    await updateLocalFlightCase(existingCase, {
      status: 'PASSENGER_INFO_FAILED',
      passengerErrorMessage:
        error instanceof Error ? error.message : 'Passenger parser failed.',
    });
    await bot.sendMessage(chatId, formatPassengerParserFailedMessage());
    return true;
  }

  let currentCase = await updateLocalFlightCase(existingCase, {
    status: 'PASSENGER_INFO_RECEIVED',
    parsedPassengerMessage,
  });
  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'PASSENGER_INFO_PARSED',
  });

  const pendingProfileIds = context?.pendingPassengerProfileIds ?? [];

  if (parsedPassengerMessage.intent === 'confirm_passenger') {
    if (pendingProfileIds.length !== 1) {
      await bot.sendMessage(chatId, 'Vui lòng chọn đúng khách trước khi xác nhận.');
      return true;
    }

    await withPassengerResolutionService(async (service) => {
      const profile = service.getProfile(pendingProfileIds[0]);

      if (!profile) {
        await bot.sendMessage(chatId, 'Không tìm thấy passenger profile local.');
        return;
      }

      await attachConfirmedPassenger(bot, chatId, currentCase, service, profile);
    });
    return true;
  }

  const mention = parsedPassengerMessage.passengerMentions[0];

  if (!mention) {
    await bot.sendMessage(
      chatId,
      parsedPassengerMessage.intent === 'reject_passenger'
        ? 'Vui lòng cho mình tên khách khác cần tìm.'
        : 'Mình chưa nhận ra tên khách. Vui lòng nhập lại họ tên khách.',
    );
    return true;
  }

  await withPassengerResolutionService(async (service) => {
    const result = service.resolveMention(mention, {
      excludeProfileIds:
        parsedPassengerMessage.intent === 'reject_passenger'
          ? pendingProfileIds
          : undefined,
      pendingPassengerProfileId:
        parsedPassengerMessage.intent === 'update_passenger_fields' &&
        pendingProfileIds.length === 1
          ? pendingProfileIds[0]
          : undefined,
    });

    await renderPassengerResolution(bot, chatId, currentCase, service, result);
  });

  return true;
}

/**
 * Renders local resolver outcomes as natural Telegram messages and buttons.
 */
async function renderPassengerResolution(
  bot: TelegramBot,
  chatId: number,
  flightCase: LocalPassengerReadyCase,
  service: PassengerResolutionService,
  result: PassengerResolveResult,
) {
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
 * Attaches a confirmed ready passenger to a booking case without Playwright.
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

  await updateLocalFlightCase(flightCase, {
    status: 'PASSENGER_INFO_CONFIRMED',
    attachedPassenger: profile,
    passengerErrorMessage: undefined,
  });
  clearPendingPassengerProfiles(chatId);
  await bot.sendMessage(
    chatId,
    formatPassengerAttachedMessage(flightCase.caseId, profile),
  );
}

async function withPassengerResolutionService(
  callback: (service: PassengerResolutionService) => Promise<void>,
) {
  const store = new PassengerStore();

  try {
    await callback(new PassengerResolutionService(store));
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
  ]).has(status);
}

function looksLikePassengerMessage(rawMessage: string) {
  return /(dùng|dung|lấy|lay)\s+(chị|chi|anh|cô|co|chú|chu|bác|bac|em|bé|be|khách|khach)|khách\s+là|khach\s+la|sinh\s+\d|cccd|cmnd|passport|hộ\s+chiếu|ho\s+chieu|không\s+phải\s+khách|khong\s+phai\s+khach|đúng\s+rồi\s+dùng\s+khách|dung\s+khach/i.test(
    rawMessage,
  );
}
