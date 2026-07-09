import TelegramBot from 'node-telegram-bot-api';
import { parseFlightSelectionMessage } from '../agent/flight-selection-parser';
import { createFlightRequestParser } from '../agent/flight-request-parser-factory';
import {
  mapParsedRequestToSearchFlightsInput,
  normalizeParsedAirportFieldsForSearch,
} from '../agent/search-flight-input-mapper';
import {
  validateAutomationSupport,
  validateSearchFlightInput,
  type PreferredTime,
} from '../contracts/flight';
import { type SearchFlightsInput } from '../automation/1booking/search-flight-input';
import { searchOneBookingFlights } from '../services/flight-search-automation-service';
import { selectMatchingOneBookingFlight } from '../services/flight-selection-automation-service';
import {
  createLocalFlightCase,
  readLocalFlightCase,
  updateLocalFlightCase,
  type LocalFlightCase,
} from '../storage/local-case-store';
import { appendLocalLog } from '../storage/local-log-store';
import { readLocalAgentSettings } from '../storage/local-settings-store';
import { isAllowedTelegramOperator } from './telegram-access';
import {
  formatCombinedFlightSelectionProgressMessage,
  formatCombinedSelectionPassengerReadyMessage,
  formatCheapestBucketRerunStartedMessage,
  formatCheapestFollowUpMissingSearchMessage,
  formatCheapestMoreMissingLatestCaseMessage,
  formatCheapestMoreOptionsMessage,
  formatCheapestMoreSearchStartedMessage,
  formatFlightSelectionFailedMessage,
  formatFlightSelectionParseFailedMessage,
  formatLatestCaseFlightSelectionResolvedMessage,
  formatFlightSelectionStartedMessage,
  formatFlightSelectionSuccessMessage,
  formatMissingFlightFieldsMessage,
  formatMoreFlightMissingLatestCaseMessage,
  formatNormalBucketRerunStartedMessage,
  formatNormalMoreOptionsMessage,
  formatOneBookingAuthRefreshStartedMessage,
  formatPassengerReadySelectionStillNeededMessage,
  formatParserFailedMessage,
  formatParsedRequestMessage,
  formatSearchFailedMessage,
  formatSearchInputMappingFailedMessage,
  formatSearchSuccessMessage,
} from './telegram-formatters';
import { handleTelegramSettingsCommand } from './telegram-settings-commands';
import { tryHandleTelegramHoldRecoveryMessage } from './telegram-hold-recovery';
import {
  getLatestFlightOptionsFollowUpContext,
  getLatestFlightSearchCase,
  setLatestFlightSearchCase,
  setLatestFlightOptionsFollowUpContext,
} from './telegram-flight-selection-context';
import { setActivePassengerCase } from './telegram-passenger-context';
import {
  messageLooksLikePassengerInfo,
  renderPassengerResolutionOutcome,
  resolvePassengerMessageForCase,
  runAutomaticPassengerHold,
  tryHandleTelegramPassengerMessage,
  type TelegramPassengerResolutionOutcome,
} from './telegram-passenger-message-handler';
import {
  createTelegramScreenshotArchive,
  createTelegramScreenshotArchiveFileOptions,
} from './telegram-screenshot-archive';
import { PassengerProfile } from '../passengers/passenger-types';

/**
 * Handles one incoming Telegram message from an operator.
 *
 * Responsibilities:
 * - Validate Telegram operator allowlist.
 * - Handle local settings commands.
 * - Accept only text messages for MVP v0.
 * - Parse the message using the configured Agent parser.
 * - Map parsed output into Playwright search input.
 * - Store local case/log memory.
 * - Run 1Booking search automation through the automation service.
 * - Send screenshot result back to Telegram.
 */
export async function handleTelegramMessage(
  bot: TelegramBot,
  message: TelegramBot.Message,
) {
  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;
  const text = message.text?.trim();

  if (!telegramUserId || !isAllowedTelegramOperator(telegramUserId)) {
    await bot.sendMessage(chatId, 'Bạn chưa có quyền sử dụng Agent này nhé.');
    return;
  }

  if (await handleTelegramSettingsCommand(bot, message)) {
    return;
  }

  if (!text) {
    await bot.sendMessage(
      chatId,
      'MVP hiện tại chỉ hỗ trợ request dạng text. Bạn gửi nội dung yêu cầu đặt vé bằng tin nhắn giúp mình nhé.',
    );
    return;
  }

  if (text.startsWith('/start')) {
    await bot.sendMessage(
      chatId,
      [
        'Xin chào, mình là Booking Flight Agent MVP.',
        '',
        'Bạn có thể gửi yêu cầu như:',
        '"Khách muốn bay từ Hà Nội vào Sài Gòn ngày mai buổi sáng"',
        '',
        'Lệnh cài đặt: /settings, /agent_on, /agent_off, /auto_search_on, /auto_search_off, /debug_on, /debug_off',
      ].join('\n'),
    );
    return;
  }

  const settings = await readLocalAgentSettings();

  if (!settings.agentEnabled) {
    await bot.sendMessage(chatId, 'Agent hiện đang tắt. Bạn dùng /agent_on để bật lại nhé.');
    return;
  }

  if (await tryHandleTelegramHoldRecoveryMessage(bot, chatId, text)) {
    return;
  }

  const latestSearchCase = getLatestFlightSearchCase(chatId);

  if (
    await tryHandleCheapestMoreSearchRequest(
      bot,
      chatId,
      text,
      latestSearchCase?.latestSearchCaseId,
    )
  ) {
    return;
  }

  if (
    await tryHandleFlightBucketFollowUpRequest(
      bot,
      chatId,
      text,
      latestSearchCase?.latestSearchCaseId,
    )
  ) {
    return;
  }

  if (
    await tryHandleMoreFlightOptionsRequest(
      bot,
      chatId,
      text,
      latestSearchCase?.latestSearchCaseId,
    )
  ) {
    return;
  }

  const selectionParseResult = parseFlightSelectionMessage(text, {
    latestCaseId: latestSearchCase?.latestSearchCaseId,
  });

  if (selectionParseResult.isSelectionMessage) {
    if (!selectionParseResult.ok) {
      await bot.sendMessage(
        chatId,
        formatFlightSelectionParseFailedMessage(
          selectionParseResult.missingFields,
        ),
      );
      return;
    }

    const isCombinedSelectionPassengerMessage =
      messageLooksLikePassengerInfo(text);

    if (
      selectionParseResult.resolvedCaseFromContext &&
      !isCombinedSelectionPassengerMessage
    ) {
      await bot.sendMessage(
        chatId,
        formatLatestCaseFlightSelectionResolvedMessage(
          selectionParseResult.input,
        ),
      );
    }

    await handleTelegramFlightSelection(
      bot,
      chatId,
      telegramUserId,
      selectionParseResult.input,
      text,
      isCombinedSelectionPassengerMessage,
    );
    return;
  }

  if (await tryHandleTelegramPassengerMessage(bot, chatId, text)) {
    return;
  }

  const flightCase = await createLocalFlightCase(text);


  // Save request information to JSON storage
  await appendLocalLog({
    level: 'info',
    event: 'telegram_request_received',
    caseId: flightCase.caseId,
    message: 'Received Telegram flight request.',
    meta: {
      telegramUserId,
      chatId,
    },
  });

  // Telegram bot solving request from rawMessage
  await bot.sendMessage(
    chatId,
    `⏳ Mình đã nhận request ${flightCase.caseId}. Đang phân tích yêu cầu nhé...`,
  );

  let parsedRequest;

  try {
    const parser = createFlightRequestParser();
    parsedRequest = await parser.parse(text);
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'AI parser failed with an unknown error.';

    await updateLocalFlightCase(flightCase, {
      status: 'CASE_FAILED',
      errorMessage,
    });
    await appendLocalLog({
      level: 'error',
      event: 'flight_request_parser_failed',
      caseId: flightCase.caseId,
      message: errorMessage,
    });
    await bot.sendMessage(chatId, formatParserFailedMessage());
    return;
  }
  
  let currentCase = await updateLocalFlightCase(flightCase, {
    status: 'SEARCH_REQUESTED',
    parsedRequest,
  });

  const normalizedParsedRequest =
    normalizeParsedAirportFieldsForSearch(parsedRequest);

  if (normalizedParsedRequest !== parsedRequest) {
    currentCase = await updateLocalFlightCase(currentCase, {
      parsedRequest: normalizedParsedRequest,
    });
  }

  await bot.sendMessage(chatId, formatParsedRequestMessage(normalizedParsedRequest));

  const inputValidation = validateSearchFlightInput(normalizedParsedRequest);
  const missingFields = Array.from(
    new Set([
      ...normalizedParsedRequest.missingFields.filter(
        (field) => !inputValidation.missingFields.includes(field),
      ),
      ...inputValidation.missingFields,
    ]),
  );

  if (missingFields.length > 0) {
    await updateLocalFlightCase(currentCase, {
      status: 'NEEDS_INPUT',
      errorMessage: `Missing fields: ${missingFields.join(', ')}`,
    });
    await appendLocalLog({
      level: 'warn',
      event: 'flight_request_missing_fields',
      caseId: currentCase.caseId,
      message: `Missing fields: ${missingFields.join(', ')}`,
    });
    await bot.sendMessage(chatId, formatMissingFlightFieldsMessage(missingFields));
    return;
  }

  const automationSupport = validateAutomationSupport(normalizedParsedRequest);

  if (!automationSupport.supported) {
    const reason =
      automationSupport.reason ??
      'Automation does not support this flight request yet.';

    await updateLocalFlightCase(currentCase, {
      status: 'CASE_FAILED',
      errorMessage: reason,
    });
    await appendLocalLog({
      level: 'warn',
      event: 'flight_request_unsupported_automation',
      caseId: currentCase.caseId,
      message: reason,
    });
    await bot.sendMessage(chatId, reason);
    return;
  }

  let searchInput;

  try {
    searchInput = mapParsedRequestToSearchFlightsInput(normalizedParsedRequest);
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Không thể chuyển yêu cầu đã parse sang input tìm chuyến.';

    await updateLocalFlightCase(currentCase, {
      status: 'CASE_FAILED',
      errorMessage,
    });
    await appendLocalLog({
      level: 'warn',
      event: 'search_input_mapping_failed',
      caseId: currentCase.caseId,
      message: errorMessage,
    });
    await bot.sendMessage(chatId, formatSearchInputMappingFailedMessage());
    return;
  }

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'SEARCH_RUNNING',
    searchInput,
  });

  if (!settings.autoSearchFlights) {
    await bot.sendMessage(
      chatId,
      'autoSearchFlights đang tắt. Mình đã lưu case rồi, nhưng chưa chạy 1Booking nhé.',
    );
    return;
  }

  await bot.sendMessage(chatId, '⏳ Mình đang tìm chuyến trên 1Booking...');

  const result = await searchOneBookingFlights(searchInput, {
    onAuthRefresh: () =>
      Promise.resolve(void bot.sendMessage(chatId, formatOneBookingAuthRefreshStartedMessage())),
  });

  if (!result.ok) {
    await updateLocalFlightCase(currentCase, {
      status: 'SEARCH_FAILED',
      errorMessage: result.message,
      screenshotPath: result.errorScreenshotPath ?? undefined,
    });
    await appendLocalLog({
      level: 'error',
      event: 'one_booking_search_failed',
      caseId: currentCase.caseId,
      message: result.message,
      meta: {
        errorScreenshotPath: result.errorScreenshotPath,
      },
    });

    await bot.sendMessage(chatId, formatSearchFailedMessage(result.message));

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot để mình cùng đối chiếu lỗi search 1Booking.',
      });
    }

    return;
  }

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'SEARCH_DONE',
    flightCount: result.flightCount,
    displayedFlightCount: result.displayedFlightCount,
    flightResultFilter: result.filterSummary,
    screenshotPath: result.screenshotPath,
    screenshotPaths: result.screenshotPaths,
  });
  setLatestFlightSearchCase(chatId, currentCase.caseId);
  setLatestFlightOptionsFollowUpContext(chatId, {
    latestSearchCaseId: currentCase.caseId,
    mode: result.filterSummary?.ranking === 'cheapest' ? 'cheapest' : 'normal',
    resultLimit:
      currentCase.searchInput?.resultRanking === 'cheapest'
        ? currentCase.searchInput.resultLimit
        : undefined,
  });
  await appendLocalLog({
    level: 'info',
    event: 'one_booking_search_completed',
    caseId: currentCase.caseId,
    message: '1Booking search completed.',
    meta: {
      flightCount: result.flightCount,
      displayedFlightCount: result.displayedFlightCount,
      flightResultFilter: result.filterSummary,
      screenshotPath: result.screenshotPath,
      screenshotPaths: result.screenshotPaths,
    },
  });

  await bot.sendMessage(
    chatId,
    formatSearchSuccessMessage(result.flightCount, result.filterSummary),
  );

  if (result.screenshotPaths.length > 0) {
    for (let index = 0; index < result.screenshotPaths.length; index++) {
      await bot.sendPhoto(chatId, result.screenshotPaths[index], {
        caption:
          result.screenshotPaths.length === 1
            ? 'Ảnh lịch trình chuyến bay từ 1Booking nhé.'
            : `Ảnh lịch trình chuyến bay ${index + 1}/${result.screenshotPaths.length}.`,
      });
    }

    const archivePath = await createTelegramScreenshotArchive(
      currentCase.caseId,
      result.screenshotPaths,
    );

    await bot.sendDocument(
      chatId,
      archivePath,
      {
        caption: 'Download All Files',
      },
      createTelegramScreenshotArchiveFileOptions(archivePath),
    );

    currentCase = await updateLocalFlightCase(currentCase, {
      status: 'OPTIONS_SENT',
    });
    return;
  }

  await bot.sendPhoto(chatId, result.screenshotPath, {
    caption: 'Ảnh lịch trình chuyến bay từ 1Booking nhé.',
  });

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'OPTIONS_SENT',
  });
}

/**
 * Handles follow-up requests such as `tôi cần thêm` after a cheapest search.
 *
 * SakuraBot asks the operator which time bucket to show next instead of
 * silently widening the customer-facing cheapest screenshots.
 */
export type CheapestBucketFollowUp = {
  preferredTime: PreferredTime;
  label: string;
  resultLimit?: 5 | 10;
};

export type CheapestMoreSearchRequest = {
  resultLimit: 5 | 10;
  preferredTime?: PreferredTime;
  bucketLabel?: string | null;
};

export type NormalFlightFollowUpRequest = {
  preferredTime?: PreferredTime;
  bucketLabel?: string | null;
};

/**
 * Handles requests such as `thêm chuyến bay giá rẻ` after a normal flight list.
 *
 * Unlike `tôi cần thêm`, this is an explicit request to rerun the latest saved
 * search and show only the top cheapest customer-facing options.
 */
async function tryHandleCheapestMoreSearchRequest(
  bot: TelegramBot,
  chatId: number,
  text: string,
  latestCaseId?: string,
) {
  const cheapestRequest = parseCheapestMoreSearchRequest(text);

  if (!cheapestRequest) {
    return false;
  }

  if (!latestCaseId) {
    await bot.sendMessage(chatId, formatCheapestMoreMissingLatestCaseMessage());
    return true;
  }

  const flightCase = await readLocalFlightCase(latestCaseId);

  if (!flightCase) {
    await bot.sendMessage(chatId, formatCheapestMoreMissingLatestCaseMessage());
    return true;
  }

  if (!flightCase.searchInput) {
    await bot.sendMessage(
      chatId,
      formatCheapestFollowUpMissingSearchMessage(flightCase.caseId),
    );
    return true;
  }

  if (!('preferredTime' in cheapestRequest)) {
    setLatestFlightOptionsFollowUpContext(chatId, {
      latestSearchCaseId: flightCase.caseId,
      mode: 'cheapest',
      resultLimit: cheapestRequest.resultLimit,
    });
    await bot.sendMessage(chatId, formatCheapestMoreOptionsMessage(flightCase));
    return true;
  }

  const patch = buildCheapestMoreSearchPatch(flightCase, cheapestRequest);
  let currentCase = await updateLocalFlightCase(flightCase, {
    ...patch,
    status: 'SEARCH_RUNNING',
    errorMessage: undefined,
    screenshotPath: undefined,
    screenshotPaths: undefined,
    flightResultFilter: undefined,
  });

  await appendLocalLog({
    level: 'info',
    event: 'cheapest_more_search_requested',
    caseId: currentCase.caseId,
    message: 'Received cheapest-flight rerun request for latest case.',
    meta: {
      preferredTime: patch.searchInput.preferredTime ?? null,
      resultLimit: patch.searchInput.resultLimit ?? null,
    },
  });

  await bot.sendMessage(
    chatId,
    formatCheapestMoreSearchStartedMessage(
      currentCase.caseId,
      cheapestRequest.resultLimit,
      getCheapestMoreProgressBucketLabel(
        cheapestRequest,
        patch.searchInput.preferredTime,
      ),
    ),
  );

  const result = await searchOneBookingFlights(patch.searchInput, {
    onAuthRefresh: () =>
      Promise.resolve(
        void bot.sendMessage(chatId, formatOneBookingAuthRefreshStartedMessage()),
      ),
  });

  if (!result.ok) {
    await updateLocalFlightCase(currentCase, {
      status: 'SEARCH_FAILED',
      errorMessage: result.message,
      screenshotPath: result.errorScreenshotPath ?? undefined,
    });
    await appendLocalLog({
      level: 'error',
      event: 'one_booking_search_failed',
      caseId: currentCase.caseId,
      message: result.message,
      meta: {
        errorScreenshotPath: result.errorScreenshotPath,
      },
    });

    await bot.sendMessage(chatId, formatSearchFailedMessage(result.message));

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot để mình cùng đối chiếu lỗi search 1Booking.',
      });
    }

    return true;
  }

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'SEARCH_DONE',
    flightCount: result.flightCount,
    displayedFlightCount: result.displayedFlightCount,
    flightResultFilter: result.filterSummary,
    screenshotPath: result.screenshotPath,
    screenshotPaths: result.screenshotPaths,
  });
  setLatestFlightSearchCase(chatId, currentCase.caseId);
  setLatestFlightOptionsFollowUpContext(chatId, {
    latestSearchCaseId: currentCase.caseId,
    mode: 'cheapest',
    resultLimit: patch.searchInput.resultLimit,
  });
  await appendLocalLog({
    level: 'info',
    event: 'one_booking_search_completed',
    caseId: currentCase.caseId,
    message: '1Booking cheapest rerun search completed.',
    meta: {
      flightCount: result.flightCount,
      displayedFlightCount: result.displayedFlightCount,
      flightResultFilter: result.filterSummary,
      screenshotPath: result.screenshotPath,
      screenshotPaths: result.screenshotPaths,
    },
  });

  await bot.sendMessage(
    chatId,
    formatSearchSuccessMessage(result.flightCount, result.filterSummary),
  );

  if (result.screenshotPaths.length > 0) {
    for (let index = 0; index < result.screenshotPaths.length; index++) {
      await bot.sendPhoto(chatId, result.screenshotPaths[index], {
        caption:
          result.screenshotPaths.length === 1
            ? 'Ảnh lịch trình chuyến bay từ 1Booking nhé.'
            : `Ảnh lịch trình chuyến bay ${index + 1}/${result.screenshotPaths.length}.`,
      });
    }

    const archivePath = await createTelegramScreenshotArchive(
      currentCase.caseId,
      result.screenshotPaths,
    );

    await bot.sendDocument(
      chatId,
      archivePath,
      {
        caption: 'Download All Files',
      },
      createTelegramScreenshotArchiveFileOptions(archivePath),
    );

    await updateLocalFlightCase(currentCase, {
      status: 'OPTIONS_SENT',
    });
    return true;
  }

  await bot.sendPhoto(chatId, result.screenshotPath, {
    caption: 'Ảnh lịch trình chuyến bay từ 1Booking nhé.',
  });

  await updateLocalFlightCase(currentCase, {
    status: 'OPTIONS_SENT',
  });

  return true;
}

/**
 * Handles bucket-only replies such as `sáng sớm` after SakuraBot has already
 * shown cheapest results for the latest case.
 */
async function tryHandleFlightBucketFollowUpRequest(
  bot: TelegramBot,
  chatId: number,
  text: string,
  latestCaseId?: string,
) {
  const bucketFollowUp = parseCheapestBucketFollowUpMessage(text);

  if (!bucketFollowUp || !latestCaseId) {
    return false;
  }

  const flightCase = await readLocalFlightCase(latestCaseId);
  const followUpContext = getLatestFlightOptionsFollowUpContext(chatId);
  const followUpMode =
    followUpContext?.latestSearchCaseId === latestCaseId
      ? followUpContext.mode
      : 'normal';

  if (!canShowCheapestMoreOptionsForCase(flightCase)) {
    if (flightCase) {
      await bot.sendMessage(
        chatId,
        formatCheapestFollowUpMissingSearchMessage(flightCase.caseId),
      );
      return true;
    }

    return false;
  }

  if (!flightCase.searchInput) {
    await bot.sendMessage(
      chatId,
      formatCheapestFollowUpMissingSearchMessage(flightCase.caseId),
    );
    return true;
  }

  const patch =
    followUpMode === 'cheapest'
      ? buildCheapestBucketSearchPatch(flightCase, {
          ...bucketFollowUp,
          resultLimit:
            followUpContext?.latestSearchCaseId === latestCaseId
              ? followUpContext.resultLimit
              : undefined,
        })
      : buildNormalBucketSearchPatch(flightCase, bucketFollowUp);
  let currentCase = await updateLocalFlightCase(flightCase, {
    ...patch,
    status: 'SEARCH_RUNNING',
    errorMessage: undefined,
    screenshotPath: undefined,
    screenshotPaths: undefined,
    flightResultFilter: undefined,
  });

  await appendLocalLog({
    level: 'info',
    event:
      followUpMode === 'cheapest'
        ? 'cheapest_bucket_follow_up_requested'
        : 'normal_bucket_follow_up_requested',
    caseId: currentCase.caseId,
    message:
      followUpMode === 'cheapest'
        ? 'Received cheapest flight bucket follow-up.'
        : 'Received normal flight bucket follow-up.',
    meta: {
      preferredTime: bucketFollowUp.preferredTime,
      label: bucketFollowUp.label,
      mode: followUpMode,
    },
  });

  const progressLabel = getBucketLabelForFollowUpMode(
    bucketFollowUp,
    followUpMode,
  );

  await bot.sendMessage(
    chatId,
    followUpMode === 'cheapest'
      ? formatCheapestBucketRerunStartedMessage(
          currentCase.caseId,
          progressLabel,
        )
      : formatNormalBucketRerunStartedMessage(
          currentCase.caseId,
          progressLabel,
        ),
  );

  const result = await searchOneBookingFlights(patch.searchInput, {
    onAuthRefresh: () =>
      Promise.resolve(
        void bot.sendMessage(chatId, formatOneBookingAuthRefreshStartedMessage()),
      ),
  });

  if (!result.ok) {
    await updateLocalFlightCase(currentCase, {
      status: 'SEARCH_FAILED',
      errorMessage: result.message,
      screenshotPath: result.errorScreenshotPath ?? undefined,
    });
    await appendLocalLog({
      level: 'error',
      event: 'one_booking_search_failed',
      caseId: currentCase.caseId,
      message: result.message,
      meta: {
        errorScreenshotPath: result.errorScreenshotPath,
      },
    });

    await bot.sendMessage(chatId, formatSearchFailedMessage(result.message));

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot để mình cùng đối chiếu lỗi search 1Booking.',
      });
    }

    return true;
  }

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'SEARCH_DONE',
    flightCount: result.flightCount,
    displayedFlightCount: result.displayedFlightCount,
    flightResultFilter: result.filterSummary,
    screenshotPath: result.screenshotPath,
    screenshotPaths: result.screenshotPaths,
  });
  setLatestFlightSearchCase(chatId, currentCase.caseId);
  await appendLocalLog({
    level: 'info',
    event: 'one_booking_search_completed',
    caseId: currentCase.caseId,
    message: '1Booking cheapest bucket search completed.',
    meta: {
      flightCount: result.flightCount,
      displayedFlightCount: result.displayedFlightCount,
      flightResultFilter: result.filterSummary,
      screenshotPath: result.screenshotPath,
      screenshotPaths: result.screenshotPaths,
    },
  });

  await bot.sendMessage(
    chatId,
    formatSearchSuccessMessage(result.flightCount, result.filterSummary),
  );

  if (result.screenshotPaths.length > 0) {
    for (let index = 0; index < result.screenshotPaths.length; index++) {
      await bot.sendPhoto(chatId, result.screenshotPaths[index], {
        caption:
          result.screenshotPaths.length === 1
            ? 'Ảnh lịch trình chuyến bay từ 1Booking nhé.'
            : `Ảnh lịch trình chuyến bay ${index + 1}/${result.screenshotPaths.length}.`,
      });
    }

    const archivePath = await createTelegramScreenshotArchive(
      currentCase.caseId,
      result.screenshotPaths,
    );

    await bot.sendDocument(
      chatId,
      archivePath,
      {
        caption: 'Download All Files',
      },
      createTelegramScreenshotArchiveFileOptions(archivePath),
    );

    await updateLocalFlightCase(currentCase, {
      status: 'OPTIONS_SENT',
    });
    return true;
  }

  await bot.sendPhoto(chatId, result.screenshotPath, {
    caption: 'Ảnh lịch trình chuyến bay từ 1Booking nhé.',
  });

  await updateLocalFlightCase(currentCase, {
    status: 'OPTIONS_SENT',
  });

  return true;
}

/**
 * Parses explicit cheap-flight rerun requests for the latest saved search.
 */
export function parseCheapestMoreSearchRequest(
  text: string,
): CheapestMoreSearchRequest | null {
  const normalizedText = normalizeVietnameseFollowUpText(text);
  const hasExplicitCount = /\b(?:5|10)\s+chuyen(?:\s+bay)?\b/.test(
    normalizedText,
  );
  const hasCheapIntent = hasCheapFlightIntent(normalizedText);
  const hasCheapFollowUpIntent =
    hasCheapIntent &&
    !hasNewFlightSearchClues(normalizedText) &&
    (/\b(?:tim|them|xem|loc|lay|cho)\b/.test(normalizedText) ||
      hasExplicitCount ||
      /\bchuyen(?:\s+bay)?\b/.test(normalizedText) ||
      /\bve\b/.test(normalizedText));

  if (!hasCheapFollowUpIntent) {
    return null;
  }

  return {
    resultLimit: /\b10\s+chuyen(?:\s+bay)?\b/.test(normalizedText) ? 10 : 5,
    ...parseCheapestFollowUpTimeBucket(normalizedText),
  };
}

/**
 * Parses normal follow-ups that should keep live 1Booking order.
 *
 * Cheap-price wording is intentionally excluded here so normal follow-ups never
 * inherit stale cheapest ranking from an earlier case.
 */
export function parseNormalFlightFollowUpRequest(
  text: string,
): NormalFlightFollowUpRequest | null {
  const normalizedText = normalizeVietnameseFollowUpText(text);

  if (hasCheapFlightIntent(normalizedText)) {
    return null;
  }

  const timeBucket = parseCheapestFollowUpTimeBucket(normalizedText);
  const hasBucket = 'preferredTime' in timeBucket;
  const isBucketOnly = parseCheapestBucketFollowUpMessage(text) !== null;
  const hasMoreIntent =
    /(?:can|muon|xem|cho|lay)\s+them|xem them|them chuyen|more/.test(
      normalizedText,
    ) ||
    /\b(?:5|10)\s+chuyen(?:\s+bay)?\b/.test(normalizedText);

  if (!hasMoreIntent && !isBucketOnly) {
    return null;
  }

  return hasBucket ? timeBucket : {};
}

/**
 * Parses an optional time bucket embedded in a cheapest-rerun request.
 */
function parseCheapestFollowUpTimeBucket(
  normalizedText: string,
): Pick<CheapestMoreSearchRequest, 'preferredTime' | 'bucketLabel'> {
  const bucketText = normalizedText.replace(/^(?:toi|minh)\s+/, '');

  if (/\b(?:tat ca|toan bo|all)\b/.test(bucketText)) {
    return {
      preferredTime: null,
      bucketLabel: null,
    };
  }

  if (/\b(?:sang som|rang sang|bay dem|dem som)\b/.test(bucketText)) {
    return {
      preferredTime: 'early_morning',
      bucketLabel: 's\u00e1ng s\u1edbm',
    };
  }

  if (/\b(?:buoi sang|sang)\b/.test(bucketText)) {
    return {
      preferredTime: 'morning',
      bucketLabel: 'bu\u1ed5i s\u00e1ng',
    };
  }

  if (/\b(?:buoi chieu|chieu)\b/.test(bucketText)) {
    return {
      preferredTime: 'afternoon',
      bucketLabel: 'bu\u1ed5i chi\u1ec1u',
    };
  }

  if (/\b(?:buoi toi|toi|dem)\b/.test(bucketText)) {
    return {
      preferredTime: 'night',
      bucketLabel: 'bu\u1ed5i t\u1ed1i',
    };
  }

  return {};
}

/**
 * Chooses the bucket label shown in the rerun progress message.
 *
 * Explicit labels from the operator message win. If the message omits a bucket,
 * the latest saved case bucket is shown so the operator sees what is preserved.
 */
function getCheapestMoreProgressBucketLabel(
  cheapestRequest: CheapestMoreSearchRequest,
  preferredTime: PreferredTime | undefined,
) {
  if ('bucketLabel' in cheapestRequest) {
    return cheapestRequest.bucketLabel;
  }

  switch (preferredTime) {
    case 'early_morning':
      return 's\u00e1ng s\u1edbm';
    case 'morning':
      return 'bu\u1ed5i s\u00e1ng';
    case 'afternoon':
      return 'bu\u1ed5i chi\u1ec1u';
    case 'night':
      return 'bu\u1ed5i t\u1ed1i';
    default:
      return null;
  }
}

/**
 * Chooses the bucket label for normal follow-up reruns.
 */
function getNormalFollowUpProgressBucketLabel(
  normalRequest: NormalFlightFollowUpRequest,
) {
  if ('bucketLabel' in normalRequest) {
    return normalRequest.bucketLabel ?? 't\u1ea5t c\u1ea3 chuy\u1ebfn';
  }

  switch (normalRequest.preferredTime) {
    case 'early_morning':
      return 's\u00e1ng s\u1edbm';
    case 'morning':
      return 'bu\u1ed5i s\u00e1ng';
    case 'afternoon':
      return 'bu\u1ed5i chi\u1ec1u';
    case 'night':
      return 'bu\u1ed5i t\u1ed1i';
    default:
      return 't\u1ea5t c\u1ea3 chuy\u1ebfn';
  }
}

/**
 * Builds a local case patch that turns the latest saved search into a
 * top-cheapest rerun while preserving the existing time bucket if not provided.
 */
export function buildCheapestMoreSearchPatch(
  flightCase: Pick<LocalFlightCase, 'searchInput' | 'parsedRequest'>,
  cheapestRequest: CheapestMoreSearchRequest,
): {
  searchInput: SearchFlightsInput;
  parsedRequest: LocalFlightCase['parsedRequest'];
} {
  const preferredTime =
    'preferredTime' in cheapestRequest
      ? cheapestRequest.preferredTime
      : (flightCase.searchInput?.preferredTime ??
        flightCase.parsedRequest?.preferredTime ??
        null);
  const searchInput = {
    ...(flightCase.searchInput as SearchFlightsInput),
    preferredTime,
    resultRanking: 'cheapest',
    resultLimit: cheapestRequest.resultLimit,
  } satisfies SearchFlightsInput;

  return {
    searchInput,
    parsedRequest: flightCase.parsedRequest
      ? {
          ...flightCase.parsedRequest,
          preferredTime,
          resultRanking: 'cheapest',
        }
      : undefined,
  };
}

/**
 * Parses one bucket-only reply for cheapest-result reruns.
 */
export function parseCheapestBucketFollowUpMessage(
  text: string,
): CheapestBucketFollowUp | null {
  const normalizedText = normalizeVietnameseFollowUpText(text);

  if (/^(sang som|rang sang|bay dem|dem som)$/.test(normalizedText)) {
    return {
      preferredTime: 'early_morning',
      label: 'S\u00e1ng s\u1edbm',
    };
  }

  if (/^(sang|buoi sang)$/.test(normalizedText)) {
    return {
      preferredTime: 'morning',
      label: 'S\u00e1ng',
    };
  }

  if (/^(chieu|buoi chieu)$/.test(normalizedText)) {
    return {
      preferredTime: 'afternoon',
      label: 'Chi\u1ec1u',
    };
  }

  if (/^(toi|dem|buoi toi|toi dem)$/.test(normalizedText)) {
    return {
      preferredTime: 'night',
      label: 'T\u1ed1i/\u0110\u00eam',
    };
  }

  if (
    /^(tat ca|tat ca chuyen|tat ca chuyen re nhat|toan bo|toan bo chuyen|toan bo chuyen re nhat|all|all cheapest)$/.test(
      normalizedText,
    )
  ) {
    return {
      preferredTime: null,
      label: 'T\u1ea5t c\u1ea3 chuy\u1ebfn r\u1ebb nh\u1ea5t',
    };
  }

  return null;
}

/**
 * Builds a local case patch that combines a bucket reply into the latest search.
 */
export function buildCheapestBucketSearchPatch(
  flightCase: Pick<LocalFlightCase, 'searchInput' | 'parsedRequest'>,
  bucketFollowUp: CheapestBucketFollowUp,
): Pick<LocalFlightCase, 'searchInput' | 'parsedRequest'> {
  const searchInput = {
    ...(flightCase.searchInput as SearchFlightsInput),
    preferredTime: bucketFollowUp.preferredTime,
    resultRanking: 'cheapest',
    resultLimit: bucketFollowUp.resultLimit ?? flightCase.searchInput?.resultLimit,
  } satisfies SearchFlightsInput;

  return {
    searchInput,
    parsedRequest: flightCase.parsedRequest
      ? {
          ...flightCase.parsedRequest,
          preferredTime: bucketFollowUp.preferredTime,
          resultRanking: 'cheapest',
        }
      : undefined,
  };
}

/**
 * Builds a patch for normal follow-ups. It clears any stale cheapest ranking so
 * normal reruns keep 1Booking order and show every matching bucket result.
 */
export function buildNormalBucketSearchPatch(
  flightCase: Pick<LocalFlightCase, 'searchInput' | 'parsedRequest'>,
  bucketFollowUp: NormalFlightFollowUpRequest,
): Pick<LocalFlightCase, 'searchInput' | 'parsedRequest'> {
  const searchInput = {
    ...(flightCase.searchInput as SearchFlightsInput),
    preferredTime:
      'preferredTime' in bucketFollowUp
        ? bucketFollowUp.preferredTime
        : (flightCase.searchInput?.preferredTime ??
          flightCase.parsedRequest?.preferredTime ??
          null),
    resultRanking: null,
    resultLimit: undefined,
  } satisfies SearchFlightsInput;

  return {
    searchInput,
    parsedRequest: flightCase.parsedRequest
      ? {
          ...flightCase.parsedRequest,
          preferredTime: searchInput.preferredTime,
          resultRanking: null,
        }
      : undefined,
  };
}

/**
 * Uses mode-specific wording for the all-results bucket label.
 */
function getBucketLabelForFollowUpMode(
  bucketFollowUp: CheapestBucketFollowUp,
  mode: 'normal' | 'cheapest',
) {
  if (bucketFollowUp.preferredTime === null) {
    return mode === 'cheapest'
      ? 'T\u1ea5t c\u1ea3 chuy\u1ebfn r\u1ebb nh\u1ea5t'
      : 'T\u1ea5t c\u1ea3 chuy\u1ebfn';
  }

  return bucketFollowUp.label;
}

function normalizeVietnameseFollowUpText(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects explicit cheap-price intent for the cheapest-flight lane.
 */
function hasCheapFlightIntent(normalizedText: string) {
  return (
    /\bgia re\b/.test(normalizedText) ||
    /\bre nhat\b/.test(normalizedText) ||
    /\bchuyen re\b/.test(normalizedText) ||
    /\bve re\b/.test(normalizedText)
  );
}

/**
 * Avoids stealing complete new flight-search requests from the AI parser.
 */
function hasNewFlightSearchClues(normalizedText: string) {
  return (
    /\b(?:ngay|hom nay|hom qua|ngay mai|mai)\b/.test(normalizedText) ||
    /\b(?:bay|di)\s+tu\b/.test(normalizedText) ||
    /\btu\s+(?:hcm|sgn|sai gon|ha noi|hn|han|da nang|dad)\b/.test(
      normalizedText,
    ) ||
    /\b(?:ra|vao|den)\s+(?:hcm|sgn|sai gon|ha noi|hn|han|da nang|dad)\b/.test(
      normalizedText,
    )
  );
}

async function tryHandleMoreFlightOptionsRequest(
  bot: TelegramBot,
  chatId: number,
  text: string,
  latestCaseId?: string,
) {
  const normalRequest = parseNormalFlightFollowUpRequest(text);

  if (!normalRequest) {
    return false;
  }

  if (!latestCaseId) {
    await bot.sendMessage(chatId, formatMoreFlightMissingLatestCaseMessage());
    return true;
  }

  const flightCase = await readLocalFlightCase(latestCaseId);

  if (!canShowCheapestMoreOptionsForCase(flightCase)) {
    if (flightCase) {
      await bot.sendMessage(
        chatId,
        formatCheapestFollowUpMissingSearchMessage(flightCase.caseId),
      );
      return true;
    }

    return false;
  }

  if (!flightCase.searchInput) {
    await bot.sendMessage(
      chatId,
      formatCheapestFollowUpMissingSearchMessage(flightCase.caseId),
    );
    return true;
  }

  if ('preferredTime' in normalRequest) {
    const patch = buildNormalBucketSearchPatch(flightCase, normalRequest);
    let currentCase = await updateLocalFlightCase(flightCase, {
      ...patch,
      status: 'SEARCH_RUNNING',
      errorMessage: undefined,
      screenshotPath: undefined,
      screenshotPaths: undefined,
      flightResultFilter: undefined,
    });

    await appendLocalLog({
      level: 'info',
      event: 'normal_follow_up_requested',
      caseId: currentCase.caseId,
      message: 'Received normal flight follow-up with a time bucket.',
      meta: {
        preferredTime: patch.searchInput?.preferredTime ?? null,
      },
    });

    await bot.sendMessage(
      chatId,
      formatNormalBucketRerunStartedMessage(
        currentCase.caseId,
        getNormalFollowUpProgressBucketLabel(normalRequest),
      ),
    );

    const result = await searchOneBookingFlights(patch.searchInput, {
      onAuthRefresh: () =>
        Promise.resolve(
          void bot.sendMessage(
            chatId,
            formatOneBookingAuthRefreshStartedMessage(),
          ),
        ),
    });

    if (!result.ok) {
      await updateLocalFlightCase(currentCase, {
        status: 'SEARCH_FAILED',
        errorMessage: result.message,
        screenshotPath: result.errorScreenshotPath ?? undefined,
      });
      await appendLocalLog({
        level: 'error',
        event: 'one_booking_search_failed',
        caseId: currentCase.caseId,
        message: result.message,
        meta: {
          errorScreenshotPath: result.errorScreenshotPath,
        },
      });

      await bot.sendMessage(chatId, formatSearchFailedMessage(result.message));

      if (result.errorScreenshotPath) {
        await bot.sendPhoto(chatId, result.errorScreenshotPath, {
          caption: 'Screenshot Ä‘á»ƒ mÃ¬nh cÃ¹ng Ä‘á»‘i chiáº¿u lá»—i search 1Booking.',
        });
      }

      return true;
    }

    currentCase = await updateLocalFlightCase(currentCase, {
      status: 'SEARCH_DONE',
      flightCount: result.flightCount,
      displayedFlightCount: result.displayedFlightCount,
      flightResultFilter: result.filterSummary,
      screenshotPath: result.screenshotPath,
      screenshotPaths: result.screenshotPaths,
    });
    setLatestFlightSearchCase(chatId, currentCase.caseId);
    setLatestFlightOptionsFollowUpContext(chatId, {
      latestSearchCaseId: currentCase.caseId,
      mode: 'normal',
    });

    await bot.sendMessage(
      chatId,
      formatSearchSuccessMessage(result.flightCount, result.filterSummary),
    );

    if (result.screenshotPaths.length > 0) {
      for (let index = 0; index < result.screenshotPaths.length; index++) {
        await bot.sendPhoto(chatId, result.screenshotPaths[index], {
          caption:
            result.screenshotPaths.length === 1
              ? 'áº¢nh lá»‹ch trÃ¬nh chuyáº¿n bay tá»« 1Booking nhÃ©.'
              : `áº¢nh lá»‹ch trÃ¬nh chuyáº¿n bay ${index + 1}/${result.screenshotPaths.length}.`,
        });
      }

      const archivePath = await createTelegramScreenshotArchive(
        currentCase.caseId,
        result.screenshotPaths,
      );

      await bot.sendDocument(
        chatId,
        archivePath,
        {
          caption: 'Download All Files',
        },
        createTelegramScreenshotArchiveFileOptions(archivePath),
      );

      await updateLocalFlightCase(currentCase, {
        status: 'OPTIONS_SENT',
      });
      return true;
    }

    await bot.sendPhoto(chatId, result.screenshotPath, {
      caption: 'áº¢nh lá»‹ch trÃ¬nh chuyáº¿n bay tá»« 1Booking nhÃ©.',
    });

    await updateLocalFlightCase(currentCase, {
      status: 'OPTIONS_SENT',
    });
    return true;
  }

  setLatestFlightOptionsFollowUpContext(chatId, {
    latestSearchCaseId: flightCase.caseId,
    mode: 'normal',
  });

  await bot.sendMessage(
    chatId,
    formatNormalMoreOptionsMessage(flightCase),
  );

  return true;
}

/**
 * Detects short follow-up wording for more flight options.
 */
export function looksLikeMoreCheapestOptionsRequest(text: string) {
  return parseNormalFlightFollowUpRequest(text) !== null;
}

/**
 * Checks whether the latest case has enough saved data to show cheapest buckets.
 */
export function canShowCheapestMoreOptionsForCase(
  flightCase: Pick<LocalFlightCase, 'searchInput'> | null | undefined,
) {
  return Boolean(flightCase?.searchInput);
}

/**
 * Handles selecting a flight from a previous Telegram search case.
 *
 * The selection path updates existing case memory and delegates live 1Booking
 * matching to the selection automation service.
 */
async function handleTelegramFlightSelection(
  bot: TelegramBot,
  chatId: number,
  telegramUserId: number,
  selectionInput: Parameters<typeof selectMatchingOneBookingFlight>[0],
  rawMessage: string,
  isCombinedSelectionPassengerMessage: boolean,
) {
  const existingCase = await readLocalFlightCase(selectionInput.caseId);

  if (!existingCase) {
    await bot.sendMessage(
      chatId,
      formatFlightSelectionFailedMessage(
        `Không tìm thấy case ${selectionInput.caseId}. Vui lòng kiểm tra lại caseId.`,
        selectionInput,
      ),
    );
    return;
  }

  if (!existingCase.searchInput) {
    await bot.sendMessage(
      chatId,
      formatFlightSelectionFailedMessage(
        `Case ${selectionInput.caseId} chưa có searchInput. Vui lòng search chuyến trước rồi mới chọn.`,
        selectionInput,
      ),
    );
    return;
  }

  let currentCase = await updateLocalFlightCase(existingCase, {
    status: 'CUSTOMER_SELECTED_OPTION',
    selectionErrorMessage: undefined,
  });
  let passengerOutcome: TelegramPassengerResolutionOutcome | null = null;

  await appendLocalLog({
    level: 'info',
    event: 'flight_selection_requested',
    caseId: selectionInput.caseId,
    message: 'Received Telegram flight selection request.',
    meta: {
      telegramUserId,
      chatId,
      selectionInput,
    },
  });

  await bot.sendMessage(
    chatId,
    isCombinedSelectionPassengerMessage
      ? formatCombinedFlightSelectionProgressMessage(selectionInput)
      : formatFlightSelectionStartedMessage(selectionInput),
  );

  if (messageLooksLikePassengerInfo(rawMessage)) {
    passengerOutcome = await resolvePassengerMessageForCase(
      rawMessage,
      currentCase,
      {
        autoConfirmReadyPassenger: true,
      },
    );
    currentCase = passengerOutcome.flightCase;
  }

  const result = await selectMatchingOneBookingFlight(selectionInput, {
    onAuthRefresh: () =>
      Promise.resolve(void bot.sendMessage(chatId, formatOneBookingAuthRefreshStartedMessage())),
  });

  if (!result.ok) {
    await updateLocalFlightCase(currentCase, {
      status: 'OPTION_MATCH_FAILED',
      selectionErrorMessage: result.message,
      selectionScreenshotPath: result.errorScreenshotPath ?? undefined,
    });
    await appendLocalLog({
      level: 'error',
      event: 'one_booking_selection_failed',
      caseId: selectionInput.caseId,
      message: result.message,
      meta: {
        errorScreenshotPath: result.errorScreenshotPath,
      },
    });

    await bot.sendMessage(
      chatId,
      formatFlightSelectionFailedMessage(result.message, selectionInput),
    );

    if (passengerOutcome?.status === 'ready') {
      await bot.sendMessage(
        chatId,
        formatPassengerReadySelectionStillNeededMessage(
          passengerOutcome.flightCase.caseId,
          passengerOutcome.profile,
        ),
      );
    } else if (passengerOutcome && passengerOutcome.status !== 'not_attempted') {
      await renderPassengerResolutionOutcome(
        bot,
        chatId,
        rebasePassengerOutcomeCase(passengerOutcome, {
          ...currentCase,
          status: 'OPTION_MATCH_FAILED',
          selectionErrorMessage: result.message,
          selectionScreenshotPath: result.errorScreenshotPath ?? undefined,
        }),
        {
          holdWhenReady: false,
        },
      );
    }

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot để mình cùng đối chiếu lỗi chọn chuyến trên 1Booking.',
      });
    }

    return;
  }

  const selectedFlight = {
    ...result.result.selectedFlight,
    selectedAt: new Date().toISOString(),
  };

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'OPTION_MATCHED',
    selectedFlight,
    selectionScreenshotPath: result.result.screenshotPath,
  });
  setActivePassengerCase(chatId, currentCase.caseId);
  await appendLocalLog({
    level: 'info',
    event: 'one_booking_selection_completed',
    caseId: currentCase.caseId,
    message: '1Booking flight selection completed.',
    meta: {
      selectedFlight,
      selectionScreenshotPath: result.result.screenshotPath,
    },
  });

  if (hasReadyPassengerForCombinedHold(currentCase)) {
    await bot.sendMessage(
      chatId,
      formatCombinedSelectionPassengerReadyMessage(
        currentCase.caseId,
        result.result.selectedFlight,
        currentCase.attachedPassenger as PassengerProfile,
      ),
    );
    await runAutomaticPassengerHold(bot, chatId, currentCase, {
      skipProgressMessage: true,
    });
    return;
  }

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'AWAITING_PASSENGER_INFO',
  });

  await bot.sendMessage(
    chatId,
    formatFlightSelectionSuccessMessage(result.result.selectedFlight),
  );
  await bot.sendPhoto(chatId, result.result.screenshotPath, {
    caption:
      'Screenshot sau khi bấm Giữ chỗ và vào màn hình thông tin khách hàng nhé.',
  });

  if (passengerOutcome && passengerOutcome.status !== 'not_attempted') {
    await renderPassengerResolutionOutcome(
      bot,
      chatId,
      rebasePassengerOutcomeCase(passengerOutcome, currentCase),
      {
        holdWhenReady: false,
      },
    );
  }
}

/**
 * Repoints a passenger outcome at the latest case snapshot before rendering.
 */
function rebasePassengerOutcomeCase(
  outcome: TelegramPassengerResolutionOutcome,
  flightCase: LocalFlightCase | null,
) {
  if (!flightCase) {
    return outcome;
  }

  return {
    ...outcome,
    flightCase,
  } as TelegramPassengerResolutionOutcome;
}

/**
 * Decides whether a selected-flight case can immediately continue to hold.
 */
export function hasReadyPassengerForCombinedHold(
  flightCase: Pick<
    LocalFlightCase,
    'attachedPassenger' | 'attachedPassengerInfo'
  >,
) {
  return Boolean(flightCase.attachedPassenger && flightCase.attachedPassengerInfo);
}
