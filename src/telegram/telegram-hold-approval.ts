import type TelegramBot from 'node-telegram-bot-api';
import { decideHoldApproval, isCurrentApproval, requestHoldApproval, requiresHoldApproval } from '../services/hold-approval-service';
import { getMissingHoldPassengerFields } from '../services/passenger-hold-automation-service';
import { readLocalFlightCase, type LocalFlightCase } from '../storage/local-case-store';
import { readLocalAgentSettings } from '../storage/local-settings-store';

/** Shows the exact saved booking summary; raw text avoids HTML interpolation. */
export async function sendHoldApproval(bot: TelegramBot, chatId: number, caseId: string) {
  const flightCase = await requestHoldApproval(caseId, chatId);
  const approval = flightCase.holdApproval!;
  const flight = flightCase.selectedFlight!;
  const passenger = flightCase.attachedPassengerInfo!;
  await bot.sendMessage(chatId, [
    `Xác nhận giữ chỗ ${caseId}`,
    `${flightCase.searchInput!.fromAirportCode} → ${flightCase.searchInput!.toAirportCode} • ${flightCase.searchInput!.departureDate}`,
    `${flight.flightNumber} • ${flight.departureTime} • ${flight.rawBookingClassCode ?? flight.bookingClass ?? ''}`,
    `Giá đã chọn: ${flight.priceText ?? 'Chưa có giá — kiểm tra lại chuyến'}`,
    `Khách: ${passenger.lastName} ${passenger.firstName} • ${passenger.gender ?? ''} • ${passenger.dob ?? 'Chưa có ngày sinh'}`,
    'Xác nhận có hiệu lực 15 phút. Chưa tạo booking.',
  ].join('\n'), { reply_markup: { inline_keyboard: [[
    { text: 'Xác nhận giữ chỗ', callback_data: `h:yes:${caseId}:${approval.token}` },
    { text: 'Hủy', callback_data: `h:no:${caseId}:${approval.token}` },
  ]] } });
}

/** Stops automatic attachment paths until the separate hold review is approved. */
export async function mayStartTelegramHold(bot: TelegramBot, chatId: number, caseId: string) {
  const settings = await readLocalAgentSettings();
  if (!settings.agentEnabled) {
    await bot.sendMessage(chatId, 'Agent hiện đang tắt.');
    return false;
  }
  const flightCase = await readLocalFlightCase(caseId);
  if (!flightCase) return false;
  if (flightCase.telegramChatId !== chatId) {
    await bot.sendMessage(chatId, 'Case không thuộc cuộc trò chuyện này hoặc chưa có thông tin nguồn. Tạo yêu cầu tìm chuyến mới.');
    return false;
  }
  // Let the existing service render terminal outcomes and missing-DOB requests.
  if (flightCase.holdSubmittedAt || ['HOLD_SUCCESS', 'PNR_EXTRACTED', 'HOLD_NEEDS_REVIEW'].includes(flightCase.status)
    || getMissingHoldPassengerFields(flightCase).length) return true;
  if (!requiresHoldApproval(settings)) return true;
  if (flightCase.holdApproval?.status === 'approved' && isCurrentApproval(flightCase, flightCase.holdApproval)) return true;
  try {
    await sendHoldApproval(bot, chatId, caseId);
  } catch (error) {
    await bot.sendMessage(chatId, error instanceof Error ? error.message : 'Không thể chuẩn bị xác nhận giữ chỗ.');
  }
  return false;
}

/** Handles authenticated approval callbacks using persisted state after restart. */
export async function tryHandleHoldApprovalCallback(
  bot: TelegramBot, chatId: number, userId: number, data: string | undefined,
  execute: (flightCase: LocalFlightCase) => Promise<void>,
) {
  const match = data?.match(/^h:(yes|no):(BK-\d{8}-\d{6}):([a-f0-9]{16})$/);
  if (!match) return false;
  if (!(await readLocalAgentSettings()).agentEnabled) {
    await bot.sendMessage(chatId, 'Agent hiện đang tắt.');
    return true;
  }
  let flightCase;
  try {
    flightCase = await decideHoldApproval(match[2], match[3], chatId, userId, match[1] === 'yes');
  } catch (error) {
    await bot.sendMessage(chatId, error instanceof Error ? error.message : 'Không thể xác nhận giữ chỗ.');
    return true;
  }
  if (match[1] === 'yes') await execute(flightCase);
  else await bot.sendMessage(chatId, `Đã hủy yêu cầu giữ chỗ ${flightCase.caseId}. Chưa tạo booking.`);
  return true;
}
