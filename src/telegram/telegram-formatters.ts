import {
  BOOKING_CLASS_LABELS,
  type FlightSelectionCandidate,
  type ParsedFlightRequest,
  type SelectMatchingFlightInput,
} from '../contracts/flight';

/**
 * Telegram presentation component.
 *
 * This file only formats operator-facing Telegram text. It must not parse raw
 * messages, call OpenAI, validate contracts, map automation input, or run
 * Playwright. Parser logic belongs in src/agent, and automation logic belongs
 * in src/automation or src/services.
 */

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
 * Formats the message used when parser output is valid but not searchable yet.
 *
 * The bot asks the operator for these fields instead of starting Playwright
 * with incomplete input.
 */
export function formatMissingFlightFieldsMessage(missingFields: string[]) {
  return [
    'Mình còn thiếu thông tin để tìm chuyến.',
    '',
    `Vui lòng bổ sung: ${missingFields.join(', ')}`,
  ].join('\n');
}

/**
 * Formats the message used when the AI parser cannot return valid JSON.
 */
export function formatParserFailedMessage() {
  return [
    'Không thể phân tích yêu cầu bằng AI parser.',
    '',
    'Vui lòng kiểm tra OPENAI_API_KEY, OPENAI_MODEL hoặc đổi FLIGHT_PARSER_PROVIDER=mock để test local.',
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

/**
 * Formats a selection parse error for Telegram.
 *
 * The operator must include the case id, airline, and departure time before the
 * bot can safely rerun 1Booking and select a refreshed flight card.
 */
export function formatFlightSelectionParseFailedMessage(missingFields: string[]) {
  return [
    'Mình chưa đủ thông tin để chọn chuyến.',
    '',
    `Còn thiếu: ${missingFields.join(', ')}`,
    '',
    'Vui lòng gửi dạng:',
    'BK-YYYYMMDD-HHMMSS chọn Vietjet lúc 05:00 hạng Eco',
  ].join('\n');
}

/**
 * Formats the selected-flight request before automation starts.
 */
export function formatFlightSelectionStartedMessage(
  input: SelectMatchingFlightInput,
) {
  return [
    `Đang mở lại case ${input.caseId} và kiểm tra chuyến còn khả dụng trên 1Booking...`,
    '',
    `Hãng: ${input.airlineName} (${input.airlineCode})`,
    `Giờ bay: ${input.departureTime}`,
    `Hạng đặt chỗ: ${BOOKING_CLASS_LABELS[input.bookingClass]} (${input.bookingClass})`,
  ].join('\n');
}

/**
 * Formats a successful selected-flight confirmation.
 *
 * Flight number is shown only after automation reads it from the matched card.
 */
export function formatFlightSelectionSuccessMessage(
  selectedFlight: FlightSelectionCandidate,
) {
  return [
    'Đã chọn đúng chuyến trên 1Booking.',
    '',
    `Hãng: ${selectedFlight.airlineName} (${selectedFlight.airlineCode})`,
    `Mã chuyến: ${selectedFlight.flightNumber}`,
    `Giờ bay: ${selectedFlight.departureTime}${
      selectedFlight.arrivalTime ? ` - ${selectedFlight.arrivalTime}` : ''
    }`,
    `Hạng đặt chỗ: ${BOOKING_CLASS_LABELS[selectedFlight.bookingClass]} (${selectedFlight.bookingClass})`,
    selectedFlight.priceText ? `Giá hiển thị: ${selectedFlight.priceText}` : null,
    '',
    'Mình đã bấm Giữ chỗ và dừng ở màn hình thông tin khách hàng để review.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Formats a selection failure for Telegram.
 */
export function formatFlightSelectionFailedMessage(message: string) {
  return [
    'Không thể chọn chuyến trên 1Booking.',
    '',
    message,
    '',
    'Mình sẽ gửi screenshot lỗi bên dưới nếu có.',
  ].join('\n');
}
