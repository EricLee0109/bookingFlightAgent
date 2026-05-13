import TelegramBot from 'node-telegram-bot-api';
import { mockParseFlightRequest } from '../agent/mock-flight-request-parser';
import { mapParsedRequestToSearchFlightsInput } from '../agent/search-flight-input-mapper';
import { searchOneBookingFlights } from '../services/flight-search-automation-service';
import { isAllowedTelegramOperator } from './telegram-access';
import {
  formatParsedRequestMessage,
  formatSearchFailedMessage,
  formatSearchSuccessMessage,
} from './telegram-formatters';

/**
 * Handles one incoming Telegram message from an operator.
 *
 * Responsibilities:
 * - Validate Telegram operator allowlist.
 * - Accept only text messages for MVP v0.
 * - Parse the message using the mock Agent parser.
 * - Map parsed output into Playwright search input.
 * - Run 1Booking search automation through the automation service.
 * - Send screenshot result back to Telegram.
 *
 * Important:
 * - Long polling transport is intentionally outside this function.
 * - Later, automation execution should move to BullMQ + Redis worker to avoid
 *   blocking the Telegram process.
 */
export async function handleTelegramMessage(
  bot: TelegramBot,
  message: TelegramBot.Message,
) {
  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;
  const text = message.text?.trim();

  if (!telegramUserId || !isAllowedTelegramOperator(telegramUserId)) {
    await bot.sendMessage(chatId, '⛔ Bạn không có quyền sử dụng Agent này.');
    return;
  }

  if (!text) {
    await bot.sendMessage(
      chatId,
      '⚠️ MVP hiện tại chỉ hỗ trợ request dạng text. Vui lòng gửi nội dung yêu cầu đặt vé.',
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
      ].join('\n'),
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    '🧠 Mình đã nhận request. Đang phân tích yêu cầu...',
  );

  const parsedRequest = await mockParseFlightRequest(text);

  await bot.sendMessage(chatId, formatParsedRequestMessage(parsedRequest));

  let searchInput;

  try {
    searchInput = mapParsedRequestToSearchFlightsInput(parsedRequest);
  } catch (error) {
    await bot.sendMessage(
      chatId,
      error instanceof Error
        ? error.message
        : 'Không thể chuyển yêu cầu đã parse sang input tìm chuyến.',
    );
    return;
  }

  await bot.sendMessage(chatId, '🔎 Đang tìm chuyến trên 1Booking...');

  const result = await searchOneBookingFlights(searchInput);

  if (!result.ok) {
    console.error('1Booking search failed:', result.message);

    await bot.sendMessage(chatId, formatSearchFailedMessage());

    if (result.errorScreenshotPath) {
      await bot.sendPhoto(chatId, result.errorScreenshotPath, {
        caption: 'Screenshot lỗi khi search 1Booking.',
      });
    }

    return;
  }

  await bot.sendMessage(chatId, formatSearchSuccessMessage(result.flightCount));

  await bot.sendPhoto(chatId, result.screenshotPath, {
    caption: 'Ảnh lịch trình chuyến bay từ 1Booking.',
  });
}
