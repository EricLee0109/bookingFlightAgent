import { type ParsedFlightRequest } from '../agent/flight-request-schema';

/**
 * Formats the parsed flight request into a readable Telegram message.
 *
 * This message helps the operator quickly verify what the Agent understood
 * before automation starts.
 */
export function formatParsedRequestMessage(parsed: ParsedFlightRequest) {
  const tripTypeLabel =
    parsed.tripType === 'round_trip' ? 'Khứ hồi' : 'Một chiều';

  return [
    '✅ Mình đã phân tích yêu cầu:',
    '',
    `Chặng: ${parsed.fromAirportCode ?? 'N/A'} -> ${
      parsed.toAirportCode ?? 'N/A'
    }`,
    `Ngày đi: ${parsed.departureDate ?? 'Chưa có'}`,
    `Ngày về: ${parsed.returnDate ?? 'Không có'}`,
    `Loại chuyến: ${tripTypeLabel}`,
    `Khung giờ: ${parsed.preferredTime ?? 'Không rõ'}`,
    '',
    parsed.missingFields.length > 0
      ? `⚠️ Còn thiếu: ${parsed.missingFields.join(', ')}`
      : 'Thông tin cơ bản đã đủ để tìm chuyến.',
  ].join('\n');
}

/**
 * Formats the successful 1Booking search result message.
 *
 * This message is sent right before or together with the screenshot.
 */
export function formatSearchSuccessMessage(flightCount: number) {
  return [
    `✅ Đã tìm thấy ${flightCount} kết quả chuyến bay.`,
    '',
    'Mình gửi screenshot lịch trình bên dưới.',
    'Bạn có thể gửi ảnh này lại cho khách trên Zalo.',
  ].join('\n');
}

/**
 * Formats a generic automation error message for Telegram.
 *
 * The screenshot error should be sent after this message if available.
 */
export function formatSearchFailedMessage() {
  return [
    '❌ Không thể tìm chuyến trên 1Booking.',
    '',
    'Có thể do:',
    '- Session 1Booking hết hạn.',
    '- UI 1Booking chưa load xong.',
    '- Selector thay đổi.',
    '- Không có chuyến phù hợp.',
    '',
    'Mình sẽ gửi screenshot lỗi bên dưới nếu có.',
  ].join('\n');
}
