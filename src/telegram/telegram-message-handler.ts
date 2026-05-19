import TelegramBot from 'node-telegram-bot-api';
import { mockParseFlightRequest } from '../agent/mock-flight-request-parser';
import { mapParsedRequestToSearchFlightsInput } from '../agent/search-flight-input-mapper';
import { searchOneBookingFlights } from '../services/flight-search-automation-service';
import {
  createLocalFlightCase,
  updateLocalFlightCase,
} from '../storage/local-case-store';
import { appendLocalLog } from '../storage/local-log-store';
import { readLocalAgentSettings } from '../storage/local-settings-store';
import { isAllowedTelegramOperator } from './telegram-access';
import {
  formatParsedRequestMessage,
  formatSearchFailedMessage,
  formatSearchSuccessMessage,
} from './telegram-formatters';
import { handleTelegramSettingsCommand } from './telegram-settings-commands';

/**
 * Handles one incoming Telegram message from an operator.
 *
 * Responsibilities:
 * - Validate Telegram operator allowlist.
 * - Handle local settings commands.
 * - Accept only text messages for MVP v0.
 * - Parse the message using the mock Agent parser.
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
    await bot.sendMessage(chatId, 'Bạn không có quyền sử dụng Agent này.');
    return;
  }

  if (await handleTelegramSettingsCommand(bot, message)) {
    return;
  }

  if (!text) {
    await bot.sendMessage(
      chatId,
      'MVP hiện tại chỉ hỗ trợ request dạng text. Vui lòng gửi nội dung yêu cầu đặt vé.',
    );
    return;
  }

  if (text.startsWith('/start')) {
    await bot.sendMessage(
      chatId,
      [
        'Xin chào, mình là Booking Flight Agent MVP.',
        '',
        'Bạn có thể gửi yêu cầu dạng:',
        '"Khách muốn bay từ Hà Nội vào Sài Gòn ngày mai buổi sáng"',
        '',
        'Lệnh cài đặt: /settings, /agent_on, /agent_off, /auto_search_on, /auto_search_off, /debug_on, /debug_off',
      ].join('\n'),
    );
    return;
  }

  const settings = await readLocalAgentSettings();

  if (!settings.agentEnabled) {
    await bot.sendMessage(chatId, 'Agent hiện đang tắt. Dùng /agent_on để bật lại.');
    return;
  }

  const flightCase = await createLocalFlightCase(text);

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

  await bot.sendMessage(
    chatId,
    `Mình đã nhận request ${flightCase.caseId}. Đang phân tích yêu cầu...`,
  );

  const parsedRequest = await mockParseFlightRequest(text);
  let currentCase = await updateLocalFlightCase(flightCase, {
    status: 'parsed',
    parsedRequest,
  });

  await bot.sendMessage(chatId, formatParsedRequestMessage(parsedRequest));

  let searchInput;

  try {
    searchInput = mapParsedRequestToSearchFlightsInput(parsedRequest);
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Không thể chuyển yêu cầu đã parse sang input tìm chuyến.';

    await updateLocalFlightCase(currentCase, {
      status: 'failed',
      errorMessage,
    });
    await appendLocalLog({
      level: 'warn',
      event: 'search_input_mapping_failed',
      caseId: currentCase.caseId,
      message: errorMessage,
    });
    await bot.sendMessage(chatId, errorMessage);
    return;
  }

  currentCase = await updateLocalFlightCase(currentCase, {
    status: 'searching',
    searchInput,
  });

  if (!settings.autoSearchFlights) {
    await bot.sendMessage(
      chatId,
      'autoSearchFlights đang tắt. Mình đã lưu case nhưng chưa chạy 1Booking.',
    );
    return;
  }

  await bot.sendMessage(chatId, 'Đang tìm chuyến trên 1Booking...');

  const result = await searchOneBookingFlights(searchInput);

  if (!result.ok) {
    await updateLocalFlightCase(currentCase, {
      status: 'failed',
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

    await bot.sendMessage(chatId, formatSearchFailedMessage());

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot lỗi khi search 1Booking.',
      });
    }

    return;
  }

  await updateLocalFlightCase(currentCase, {
    status: 'completed',
    flightCount: result.flightCount,
    screenshotPath: result.screenshotPath,
  });
  await appendLocalLog({
    level: 'info',
    event: 'one_booking_search_completed',
    caseId: currentCase.caseId,
    message: '1Booking search completed.',
    meta: {
      flightCount: result.flightCount,
      screenshotPath: result.screenshotPath,
    },
  });

  await bot.sendMessage(chatId, formatSearchSuccessMessage(result.flightCount));

  await bot.sendPhoto(chatId, result.screenshotPath, {
    caption: 'Ảnh lịch trình chuyến bay từ 1Booking.',
  });
}
