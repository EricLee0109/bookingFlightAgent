import { InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { type FlightResultFilterSummary } from '../automation/1booking/flight-result-ranking';
import {
  BOOKING_CLASS_LABELS,
  type FlightSelectionCandidate,
  type ParsedFlightRequest,
  type SelectMatchingFlightInput,
} from '../contracts/flight';
import { type PassengerMention } from '../contracts/passenger';
import { type PassengerProfile } from '../passengers/passenger-types';
import { type LocalFlightCase } from '../storage/local-case-store';
import type TelegramBot from 'node-telegram-bot-api';

/**
 * Telegram presentation component.
 *
 * This file only formats operator-facing Telegram text. It must not parse raw
 * messages, call OpenAI, validate contracts, map automation input, or run
 * Playwright. Parser logic belongs in src/agent, and automation logic belongs
 * in src/automation or src/services.
 *
 * Voice rule:
 * - Warm, concise, operator-first, and safe enough for future customer-facing use.
 * - Use light status emoji only where it helps scanning.
 * - Never expose raw debug, selector, credential, or AI error text to Telegram.
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
      ? `📝 Mình cần bổ sung: ${parsed.missingFields.join(', ')}`
      : 'Thông tin cơ bản đã sẵn sàng để tìm chuyến.',
  ].join('\n');
}

/**
 * Formats the message used when parser output is valid but not searchable yet.
 *
 * The bot asks the operator for these fields instead of starting Playwright
 * with incomplete input.
 */
export function formatMissingFlightFieldsMessage(missingFields: string[]) {
  const labels = Array.from(new Set(formatOperatorFieldLabels(missingFields)));

  return [
    '📝 Mình cần thêm một chút thông tin để tìm chuyến nhé.',
    '',
    `Cần thêm: ${labels.join(', ')}.`,
    '',
    'Bạn có thể gửi:',
    'bay từ SGN ra HAN ngày 30/07',
    'bay từ Hà Nội vào Sài Gòn ngày mai buổi sáng',
  ].join('\n');
}

/**
 * Formats the message used when the AI parser cannot return valid JSON.
 */
export function formatParserFailedMessage() {
  return [
    '📝 Mình chưa đọc rõ yêu cầu bay này.',
    '',
    'Bạn gửi lại ngắn gọn theo mẫu giúp mình nhé:',
    'bay từ SGN ra HAN ngày 30/07',
  ].join('\n');
}

/**
 * Formats the successful 1Booking search result message.
 *
 * This message is sent right before or together with the screenshot.
 */
export function formatSearchSuccessMessage(
  flightCount: number,
  filterSummary?: FlightResultFilterSummary,
) {
  if (filterSummary?.ranking === 'cheapest') {
    const bucketText = filterSummary.requestedTimeBucketLabel
      ? `trong khung ${filterSummary.requestedTimeBucketLabel}`
      : 'trong toàn bộ danh sách';
    const priceRangeLine = filterSummary.priceRangeText
      ? `Khoảng giá: ${filterSummary.priceRangeText}.`
      : null;

    return [
      `✅ Mình đã lọc ${filterSummary.displayedCount} chuyến rẻ nhất ${bucketText}.`,
      `Tổng kết quả live: ${filterSummary.totalVisibleCount} chuyến.`,
      priceRangeLine,
      '',
      'Mình gửi ảnh lịch trình bên dưới nhé.',
      'Bạn có thể gửi ảnh này lại cho khách trên Zalo.',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  return [
    `✅ Đã tìm thấy ${flightCount} kết quả chuyến bay.`,
    '',
    'Mình gửi ảnh lịch trình bên dưới nhé.',
    'Bạn có thể gửi ảnh này lại cho khách trên Zalo.',
  ].join('\n');
}

/**
 * Formats a generic automation error message for Telegram.
 *
 * The screenshot error should be sent after this message if available.
 */
export function formatSearchFailedMessage(message?: string) {
  return [
    '⚠️ Mình chưa tìm được chuyến trên 1Booking.',
    '',
    formatSearchFailureReason(message),
    '',
    'Bạn có thể thử lại theo mẫu:',
    'bay từ SGN ra HAN ngày 30/07',
    '',
    'Mình gửi screenshot bên dưới để bạn đối chiếu nếu có nhé.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Asks the operator which cheapest-result bucket to show next.
 *
 * The bot does not silently widen cheapest results because customer-facing
 * screenshots should remain traceable to the operator's requested time frame.
 */
export function formatCheapestMoreOptionsMessage(flightCase: LocalFlightCase) {
  const currentBucket =
    flightCase.flightResultFilter?.requestedTimeBucketLabel ?? 'toàn bộ danh sách';

  return [
    `📝 Mình đang hiển thị nhóm chuyến rẻ nhất của case ${flightCase.caseId}.`,
    `Khung hiện tại: ${currentBucket}.`,
    '',
    'Bạn muốn mình xem thêm nhóm nào?',
    '⛅ Sáng sớm',
    '🌤️ Sáng',
    '🌥️ Chiều',
    '🌙 Tối',
    '✈️ Tất cả chuyến rẻ nhất',
  ].join('\n');
}

/**
 * Formats progress while rerunning the same cheapest-result case with a new
 * time bucket selected by the operator.
 */
export function formatCheapestBucketRerunStartedMessage(
  caseId: string,
  bucketLabel: string,
) {
  return `⏳ Mình đang lọc lại case ${caseId} theo khung ${bucketLabel}...`;
}

/**
 * Formats the rare case where a cheapest follow-up has no saved search input.
 */
export function formatCheapestFollowUpMissingSearchMessage(caseId: string) {
  return [
    `📝 Mình chưa có dữ liệu chuyến đã lưu cho case ${caseId}.`,
    'Bạn search lại chuyến giúp mình nhé.',
  ].join('\n');
}

/**
 * Formats a parser-to-search mapping failure without exposing mapper internals.
 */
export function formatSearchInputMappingFailedMessage() {
  return [
    '📝 Mình cần thêm một chút thông tin để tạo yêu cầu tìm chuyến.',
    '',
    'Bạn gửi lại theo mẫu giúp mình nhé:',
    'bay từ SGN ra HAN ngày 30/07',
  ].join('\n');
}

/**
 * Formats a selection parse error for Telegram.
 *
 * The operator must include the case id, airline, and departure time before the
 * bot can safely rerun 1Booking and select a refreshed flight card.
 */
export function formatFlightSelectionParseFailedMessage(missingFields: string[]) {
  const labels = Array.from(new Set(formatOperatorFieldLabels(missingFields)));

  return [
    '📝 Mình cần thêm một chút thông tin để chọn đúng chuyến nhé.',
    '',
    `Cần thêm: ${labels.join(', ')}.`,
    '',
    'Bạn có thể gửi:',
    'chọn chuyến Vietjet 22:15',
    'đặt chuyến VJ 22:15',
    'BK-YYYYMMDD-HHMMSS chọn VJ 22:15 hạng Eco',
  ].join('\n');
}

/**
 * Formats the selected-flight request before automation starts.
 */
export function formatFlightSelectionStartedMessage(
  input: SelectMatchingFlightInput,
) {
  return [
    `⏳ Mình đang mở lại case ${input.caseId} và kiểm tra chuyến còn khả dụng trên 1Booking...`,
    '',
    `Hãng: ${
      input.airlineName && input.airlineCode
        ? `${input.airlineName} (${input.airlineCode})`
        : 'Chưa chỉ định - sẽ đối chiếu danh sách live'
    }`,
    `Giờ bay: ${input.departureTime}`,
    `Hạng đặt chỗ: ${formatSelectionBookingClass(input.bookingClass)}`,
  ].join('\n');
}

/**
 * Formats the resolved latest-case selection before Playwright refresh starts.
 */
export function formatLatestCaseFlightSelectionResolvedMessage(
  input: SelectMatchingFlightInput,
) {
  return [
    `Mình sẽ dùng case gần nhất ${input.caseId} để chọn chuyến nhé.`,
    '',
    `Giờ bay: ${input.departureTime}`,
    `Hãng: ${
      input.airlineName && input.airlineCode
        ? `${input.airlineName} (${input.airlineCode})`
        : 'Chưa chỉ định'
    }`,
    `Hạng đặt chỗ: ${formatSelectionBookingClass(input.bookingClass)}`,
    '',
    'Mình sẽ kiểm tra lại danh sách chuyến live trước khi chọn nhé.',
  ].join('\n');
}

/**
 * Formats one compact progress message for combined select-flight/passenger.
 */
export function formatCombinedFlightSelectionProgressMessage(
  input: SelectMatchingFlightInput,
) {
  const airline =
    input.airlineName && input.airlineCode
      ? `${input.airlineName} ${input.airlineCode}`
      : 'chuyến phù hợp';

  return `⏳ Mình đang xử lý case ${input.caseId}: chọn ${airline} ${input.departureTime} và kiểm tra khách...`;
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
    '✅ Đã chọn đúng chuyến trên 1Booking.',
    '',
    `Hãng: ${selectedFlight.airlineName} (${selectedFlight.airlineCode})`,
    `Mã chuyến: ${selectedFlight.flightNumber}`,
    `Giờ bay: ${selectedFlight.departureTime}${
      selectedFlight.arrivalTime ? ` - ${selectedFlight.arrivalTime}` : ''
    }`,
    `Hạng đặt chỗ: ${BOOKING_CLASS_LABELS[selectedFlight.bookingClass]} (${selectedFlight.bookingClass})`,
    selectedFlight.priceText ? `Giá hiển thị: ${selectedFlight.priceText}` : null,
    '',
    'Mình đã bấm Giữ chỗ và dừng ở màn hình thông tin khách hàng để mình cùng review.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Formats a selection failure for Telegram.
 */
export function formatFlightSelectionFailedMessage(
  message: string,
  input?: SelectMatchingFlightInput,
) {
  return [
    '⚠️ Mình chưa chọn được chuyến này.',
    '',
    formatFlightSelectionFailureReason(message, input),
    '',
    'Bạn đối chiếu screenshot rồi gửi lại theo mẫu này giúp mình nhé:',
    buildFlightSelectionRetryExample(input),
    '',
    'Mình gửi screenshot bên dưới để bạn dễ kiểm tra.',
  ].join('\n');
}

/**
 * Formats the combined flow checkpoint before automatic fill and hold starts.
 */
export function formatCombinedSelectionPassengerReadyMessage(
  caseId: string,
  _selectedFlight: FlightSelectionCandidate,
  _profile: PassengerProfile,
) {
  return [
    `✈️✅ Đã chọn chuyến và nhận khách cho case ${caseId}.`,
    'Mình đang tiến hành giữ chỗ trên 1Booking, đợi 1 xíu nhé...',
  ].join('\n');
}

/**
 * Formats the case where passenger data is saved but flight selection failed.
 */
export function formatPassengerReadySelectionStillNeededMessage(
  caseId: string,
  profile: PassengerProfile,
) {
  return [
    `✅ Đã lưu khách vào case ${caseId}.`,
    '',
    ...formatPassengerSummaryLines(profile),
    '',
    'Mình vẫn cần chọn lại chuyến để làm tiếp.',
    'Bạn gửi theo mẫu:',
    `case ${caseId} chọn chuyến Vietjet 13:30`,
  ].join('\n');
}

/**
 * Formats a ready local passenger candidate before final operator confirmation.
 */
export function formatPassengerMatchedMessage(profile: PassengerProfile) {
  return [
    '✅ Mình đã tìm thấy khách phù hợp:',
    '',
    ...formatPassengerSummaryLines(profile),
    '',
    'Bạn xác nhận giúp mình trước khi gắn khách vào case nhé.',
  ].join('\n');
}

/**
 * Formats an ambiguous local resolver result before candidate buttons.
 */
export function formatPassengerAmbiguousMessage(candidateCount: number) {
  return [
    `📝 Mình thấy có ${candidateCount} khách gần giống.`,
    'Bạn chọn đúng khách bên dưới giúp mình nhé.',
  ].join('\n');
}

/**
 * Formats a local resolver miss and requests manual passenger details.
 */
export function formatPassengerNotFoundMessage() {
  return [
    '📝 Mình chưa tìm thấy khách phù hợp trong dữ liệu local.',
    '',
    'Cần: Giới tính + Họ tên.',
    '',
    'Gửi theo mẫu:',
    'Nữ, Nguyễn Thị Oanh',
    'Nam, Nguyễn Văn A',
    'Nữ, Nguyễn Thị Oanh, sinh 02/01/1995',
  ].join('\n');
}

/**
 * Formats only the passenger fields still required before later form fill.
 */
export function formatPassengerMissingFieldsMessage(
  profile: PassengerProfile,
  missingFields: string[],
) {
  const labels = formatPassengerMissingFieldLabels(missingFields);
  const sampleLines = buildPassengerQuickInputExamples({
    fullName: profile.normalizedFullName,
    gender:
      profile.gender === true
        ? 'male'
        : profile.gender === false
          ? 'female'
          : null,
    dob: profile.dateOfBirth,
  });

  return [
    `📝 Mình đã tìm thấy ${profile.normalizedFullName}, nhưng còn thiếu một chút thông tin.`,
    '',
    `Còn thiếu: ${labels.join(', ')}.`,
    '',
    'Bạn có thể gửi nhanh theo mẫu này nhé:',
    ...sampleLines,
  ].join('\n');
}

/**
 * Formats missing fields for a passenger who is not stored locally yet.
 */
export function formatNewPassengerMissingFieldsMessage(
  missingFields: string[],
  mention?: PassengerMention,
) {
  const labels = Array.from(
    new Set(formatPassengerMissingFieldLabels(missingFields)),
  );
  const knownLines = formatKnownPassengerDraftLines(mention);
  const sampleLines = buildPassengerQuickInputExamples(mention);

  return [
    '📝 Mình cần thêm một chút thông tin để lưu khách mới.',
    '',
    ...knownLines,
    knownLines.length > 0 ? '' : null,
    `Cần: ${labels.join(', ')}.`,
    '',
    'Gửi theo mẫu:',
    ...sampleLines,
    '',
    'Ngày sinh không bắt buộc, chỉ thêm khi cần nhé.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Formats successful passenger attachment before automatic Playwright fill.
 */
export function formatPassengerAttachedMessage(
  caseId: string,
  profile: PassengerProfile,
) {
  return [
    `✅ Đã gắn khách vào case ${caseId}.`,
    '',
    ...formatPassengerSummaryLines(profile),
    '',
    'Trạng thái: passenger_ready.',
    'Mình sẽ tự động nhập form và giữ chỗ trên 1Booking nhé.',
  ].join('\n');
}

/**
 * Formats the automatic form-fill and hold progress message.
 */
export function formatPassengerHoldRunningMessage(caseId: string) {
  return `⏳ Mình đang nhập thông tin khách và giữ chỗ cho case ${caseId} trên 1Booking...`;
}

/**
 * Formats the VN-only DOB follow-up before automatic browser launch.
 */
export function formatPassengerHoldMissingDobMessage(profile: PassengerProfile) {
  return [
    `📝 Chuyến Vietnam Airlines cần ngày sinh của ${profile.normalizedFullName} trước khi giữ chỗ.`,
    '',
    'Bạn bổ sung giúp mình theo mẫu: sinh 02/01/1995',
  ].join('\n');
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function centerText(value: string, width: number): string {
  const length = Array.from(value).length;
  const totalPadding = Math.max(width - length, 0);
  const left = Math.floor(totalPadding / 2);
  const right = totalPadding - left;

  return `${' '.repeat(left)}${value}${' '.repeat(right)}`;
}

function createPnrTicketBlock(pnrCode: string): string {
  const pnr = pnrCode.trim().toUpperCase();
  const width = Math.max(18, Array.from(pnr).length + 10);

  return [
    `╭${'─'.repeat(width)}╮`,
    `│${centerText(pnr, width)}│`,
    `╰${'─'.repeat(width)}╯`,
  ].join('\n');
}

/**
 * Formats successful hold confirmation with a more prominent PNR for Telegram HTML mode.
 */
export function formatPassengerHoldSuccessMessage(
  caseId: string,
  pnrCode: string | null,
  pnrWarning?: string,
): string {
  const safeCaseId = escapeTelegramHtml(caseId);
  const safeWarning = pnrWarning ? escapeTelegramHtml(pnrWarning) : null;

  const pnrSection = pnrCode
    ? [
        '<b>✈️ PNR ✈️</b>',
        `<pre>${escapeTelegramHtml(createPnrTicketBlock(pnrCode))}</pre>`,
      ].join('\n')
    : ['<b>✈️ PNR ✈️</b>', '<i>Chưa lấy được</i>'].join('\n');

  return [
    '<b>✅ GIỮ CHỖ THÀNH CÔNG</b>',
    '',
    pnrSection,
    '',
    `📋 <b>Case:</b> <code>${safeCaseId}</code>`,
    '✅ <b>Trạng thái:</b> <code>successful_hold</code>',
    safeWarning ? `⚠️ <i>Lưu ý: ${safeWarning}</i>` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export type PassengerHoldSuccessReplyMarkupInput = {
  caseId: string;
  pnrCode: string | null;
};

/**
 * Inline keyboard: adds Copy PNR and detail-view buttons under the message.
 */
export function buildPassengerHoldSuccessReplyMarkup(
  input: PassengerHoldSuccessReplyMarkupInput,
): InlineKeyboardMarkup | undefined {
  const { caseId, pnrCode } = input;

  if (!pnrCode) return undefined;

  return {
    inline_keyboard: [
      [
        {
          text: '📋 Copy PNR',
          copy_text: {
            text: pnrCode.trim().toUpperCase(),
          },
        },
        {
          text: '🔎 Xem chi tiết',
          callback_data: `pnr:detail:${caseId.toUpperCase()}`,
        },
      ],
    ],
  };
}

/**
 * Formats the operator-facing held booking details shown after `Xem chi tiết`.
 */
export function formatPnrDetailMessage(flightCase: LocalFlightCase) {
  const selectedFlight = flightCase.selectedFlight;
  const passenger = flightCase.attachedPassenger;

  return [
    '<b>🔎 Chi tiết giữ chỗ</b>',
    '',
    `✈️ <b>PNR:</b> <code>${escapeTelegramHtml(flightCase.pnrCode ?? 'Chưa có')}</code>`,
    `🏷️ <b>Hãng:</b> ${escapeTelegramHtml(formatPnrDetailFlightBrand(flightCase))}`,
    `🕒 <b>Giờ bay:</b> ${escapeTelegramHtml(formatPnrDetailFlightTime(flightCase))}`,
    `👤 <b>Khách:</b> ${escapeTelegramHtml(passenger?.normalizedFullName ?? 'Chưa có')}`,
    `📋 <b>Case:</b> <code>${escapeTelegramHtml(flightCase.caseId)}</code>`,
    `✅ <b>Trạng thái:</b> <code>${escapeTelegramHtml(flightCase.status)}</code>`,
    selectedFlight?.flightNumber
      ? `🛫 <b>Mã chuyến:</b> <code>${escapeTelegramHtml(selectedFlight.flightNumber)}</code>`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Formats a soft failure when local case details are unavailable.
 */
export function formatPnrDetailUnavailableMessage() {
  return [
    '📝 Mình chưa lấy được chi tiết giữ chỗ từ case local.',
    '',
    'Bạn kiểm tra lại mã case hoặc mở case trên 1Booking giúp mình nhé.',
  ].join('\n');
}

/**
 * Formats the brief operator notice shown before automatic 1Booking re-login.
 */
export function formatOneBookingAuthRefreshStartedMessage() {
  return '⏳ Phiên 1Booking đã hết hạn, mình đang tự đăng nhập lại nhé...';
}

/**
 * Formats an uncertain post-submit hold state that must not be auto-retried.
 */
export function formatPassengerHoldNeedsReviewMessage(message: string) {
  return [
    '⚠️ Mình đã gửi thao tác giữ chỗ lên 1Booking, nhưng chưa xác nhận được trạng thái cuối.',
    '',
    'Bạn kiểm tra đơn hàng hiện có trên 1Booking trước khi thử lại để tránh giữ chỗ trùng nhé.',
    '',
    message,
  ].join('\n');
}

/**
 * Formats a failed automatic passenger fill or hold attempt.
 */
export function formatPassengerHoldFailedMessage(message: string) {
  return [
    '⚠️ Mình chưa giữ chỗ được trên 1Booking.',
    '',
    formatPassengerHoldFailureReason(message),
    '',
    'Bạn kiểm tra lại thông tin khách/chuyến rồi thử lại giúp mình nhé.',
    '',
    'Mình gửi screenshot bên dưới để bạn đối chiếu nếu có nhé.',
  ].join('\n');
}

/**
 * Formats a passenger AI parser failure for local operator troubleshooting.
 */
export function formatPassengerParserFailedMessage() {
  return [
    '📝 Mình chưa đọc rõ thông tin khách.',
    '',
    'Bạn gửi theo mẫu này giúp mình nhé:',
    'Nữ, Nguyễn Thị Oanh',
    'Nam, Nguyễn Văn A',
  ].join('\n');
}

/**
 * Formats the missing active-case instruction for passenger messages.
 */
export function formatPassengerCaseRequiredMessage() {
  return [
    '📝 Mình chưa biết đang thao tác case nào.',
    '',
    'Bạn gửi theo mẫu này giúp mình nhé:',
    'BK-YYYYMMDD-HHMMSS lấy khách Nữ, Nguyễn Thị Oanh',
    'hoặc chọn chuyến trước rồi gửi: Nữ, Nguyễn Thị Oanh',
  ].join('\n');
}

/**
 * Formats an explicit case that cannot receive passenger info yet.
 */
export function formatPassengerCaseNotReadyMessage(caseId: string) {
  return [
    `📝 Case ${caseId} chưa sẵn sàng để nhận thông tin khách.`,
    '',
    'Bạn chọn chuyến trước, rồi gửi khách theo mẫu:',
    'Nữ, Nguyễn Thị Oanh',
  ].join('\n');
}

/**
 * Formats a missing local passenger profile selected from stale buttons.
 */
export function formatPassengerProfileMissingMessage() {
  return [
    '📝 Mình chưa tìm thấy khách này trong dữ liệu local.',
    '',
    'Bạn gửi lại tên khách theo mẫu này giúp mình nhé:',
    'Nữ, Nguyễn Thị Oanh',
  ].join('\n');
}

/**
 * Formats a passenger message that the parser could not turn into a mention.
 */
export function formatPassengerMentionMissingMessage(isRejectIntent: boolean) {
  return isRejectIntent
    ? [
        '📝 Mình chưa biết cần tìm khách nào khác.',
        '',
        'Bạn gửi lại theo mẫu này giúp mình nhé:',
        'tìm khách Nguyễn Thị Oanh khác',
      ].join('\n')
    : [
        '📝 Mình chưa nhận ra tên khách.',
        '',
        'Bạn gửi lại theo mẫu này giúp mình nhé:',
        'Nữ, Nguyễn Thị Oanh',
      ].join('\n');
}

/**
 * Formats an explicit local hold recovery syntax error.
 */
export function formatHoldRecoveryParseFailedMessage() {
  return [
    '📝 Mình chưa hiểu lệnh recover hold.',
    '',
    'Bạn gửi đúng mẫu này giúp mình nhé:',
    'recover BK-YYYYMMDD-HHMMSS PNR ABC123',
  ].join('\n');
}

/**
 * Formats a local hold recovery failure without leaking raw service wording.
 */
export function formatHoldRecoveryFailedMessage(message: string) {
  if (/PNR .*không hợp lệ|PNR phải/i.test(message)) {
    return [
      '📝 PNR chưa đúng định dạng.',
      '',
      'PNR cần gồm 6 ký tự chữ/số, ví dụ:',
      'recover BK-YYYYMMDD-HHMMSS PNR ABC123',
    ].join('\n');
  }

  if (/không tìm thấy case/i.test(message)) {
    return [
      '📝 Mình chưa tìm thấy case cần recover.',
      '',
      'Bạn kiểm tra lại mã case rồi gửi theo mẫu:',
      'recover BK-YYYYMMDD-HHMMSS PNR ABC123',
    ].join('\n');
  }

  return [
    '⚠️ Mình chưa recover hold được cho case này.',
    '',
    'Chỉ recover khi case đang cần kiểm tra hold hoặc đã hold nhưng thiếu PNR.',
  ].join('\n');
}

/**
 * Converts internal field names into short operator-facing Vietnamese labels.
 */
export function formatOperatorFieldLabels(fields: string[]) {
  return fields.map((field) => {
    if (field === 'departureTime') return 'giờ bay';
    if (field === 'caseId') return 'mã case';
    if (field === 'bookingClass') return 'hạng đặt chỗ';
    if (field === 'fromAirportCode' || field === 'fromAirportText') {
      return 'sân bay đi';
    }
    if (field === 'toAirportCode' || field === 'toAirportText') {
      return 'sân bay đến';
    }
    if (field === 'departureDate' || field === 'departureDate:YYYY-MM-DD') {
      return 'ngày bay';
    }
    if (field === 'returnDate') return 'ngày về';
    if (field === 'fullName') return 'họ tên';
    if (field === 'gender') return 'giới tính';
    if (field === 'dob') return 'ngày sinh';

    return field;
  });
}

function formatPassengerSummaryLines(profile: PassengerProfile) {
  return [
    `Khách: ${profile.normalizedFullName}`,
    `Giới tính: ${
      profile.gender === true
        ? 'Nam'
        : profile.gender === false
          ? 'Nữ'
          : 'Chưa có'
    }`,
    `Ngày sinh: ${profile.dateOfBirth ?? 'Không bắt buộc'}`,
  ];
}

/**
 * Converts internal passenger field names into operator-facing Vietnamese.
 */
function formatPassengerMissingFieldLabels(missingFields: string[]) {
  return formatOperatorFieldLabels(missingFields).map((label) =>
    label === 'họ tên' ? 'họ tên đầy đủ' : label,
  );
}

/**
 * Shows the passenger draft already understood before requesting more data.
 */
function formatKnownPassengerDraftLines(mention?: PassengerMention) {
  if (!mention) {
    return [];
  }

  return [
    mention.fullName ? `Mình đã nhận tên: ${mention.fullName}` : null,
    mention.gender
      ? `Mình đã nhận giới tính: ${formatMentionGender(mention.gender)}`
      : null,
    mention.dob ? `Mình đã nhận ngày sinh: ${mention.dob}` : null,
  ].filter((line): line is string => line !== null);
}

/**
 * Builds copy-ready passenger input examples for Telegram operators.
 */
function buildPassengerQuickInputExamples(mention?: PassengerMention) {
  const fullName = mention?.fullName;
  const genderLabel = mention?.gender
    ? formatMentionGender(mention.gender)
    : null;

  if (fullName && !genderLabel) {
    return [`Nữ, ${fullName}`, `Nam, ${fullName}`];
  }

  if (!fullName && genderLabel) {
    return [`${genderLabel}, <họ tên khách>`];
  }

  if (fullName && genderLabel) {
    return [
      `${genderLabel}, ${fullName}`,
      `${genderLabel}, ${fullName}, sinh 02/01/1995`,
    ];
  }

  return [
    'Nữ, Nguyễn Thị Oanh',
    'Nam, Nguyễn Văn A',
    'Nữ, Nguyễn Thị Oanh, sinh 02/01/1995',
  ];
}

/**
 * Formats parser gender values as the exact words operators can reuse.
 */
function formatMentionGender(gender: PassengerMention['gender']) {
  return gender === 'male' ? 'Nam' : 'Nữ';
}

function formatSelectionBookingClass(
  bookingClass: keyof typeof BOOKING_CLASS_LABELS | null,
) {
  return bookingClass
    ? `${BOOKING_CLASS_LABELS[bookingClass]} (${bookingClass})`
    : 'Không chỉ định - sẽ chọn chuyến duy nhất khớp giờ/hãng';
}

function formatSearchFailureReason(message?: string) {
  if (message && /No cheapest flight results matched/i.test(message)) {
    return [
      'Mình chưa thấy chuyến rẻ nhất nào trong khung giờ đã chọn.',
      '',
      'Bạn chọn giúp mình khung khác hoặc toàn bộ chuyến rẻ nhất:',
      'sáng sớm',
      'sáng',
      'chiều',
      'tối',
      'tất cả chuyến rẻ nhất',
    ].join('\n');
  }

  if (message && /auth session expired|login is required|đăng nhập/i.test(message)) {
    return 'Phiên 1Booking có thể vừa hết hạn. Mình sẽ tự đăng nhập lại khi flow cho phép.';
  }

  if (message && /loading|timeout|load|still/i.test(message)) {
    return '1Booking đang tải hơi lâu hoặc chưa trả danh sách chuyến ổn định.';
  }

  return 'Có thể 1Booking chưa trả kết quả ổn định hoặc chưa có chuyến phù hợp.';
}

function formatFlightSelectionFailureReason(
  message: string,
  input?: SelectMatchingFlightInput,
) {
  if (/case .*not found|không tìm thấy case/i.test(message)) {
    return 'Mình chưa tìm thấy mã case này trong dữ liệu local.';
  }

  if (/no saved search input|chưa có searchInput/i.test(message)) {
    return 'Case này chưa có kết quả tìm chuyến đã lưu. Bạn search chuyến trước giúp mình nhé.';
  }

  if (/multiple matching|Found \d+ matching/i.test(message)) {
    return [
      'Có nhiều chuyến cùng khớp thông tin đã gửi.',
      '',
      'Bạn thêm hạng đặt chỗ hoặc hãng rõ hơn giúp mình nhé.',
    ].join('\n');
  }

  if (input && /No available flight matched/i.test(message)) {
    return [
      'Mình chưa thấy chuyến khớp:',
      `Hãng: ${formatSelectionAirline(input)}`,
      `Giờ bay: ${input.departureTime}`,
      `Hạng: ${formatSelectionBookingClassShort(input.bookingClass)}`,
    ].join('\n');
  }

  return 'Danh sách chuyến live trên 1Booking chưa khớp với thông tin vừa gửi.';
}

function formatPassengerHoldFailureReason(message: string) {
  if (/auth session expired|login is required|đăng nhập/i.test(message)) {
    return 'Phiên 1Booking có thể vừa hết hạn trước khi giữ chỗ.';
  }

  if (
    /does not support hold booking|không hỗ trợ giữ chỗ|khong ho tro giu cho|Xuất vé ngay|Xuat ve ngay/i.test(
      message,
    )
  ) {
    return [
      'Chuyến/hạng này chưa hỗ trợ giữ chỗ trên 1Booking.',
      '',
      'Bạn chọn lại chuyến hoặc hạng khác có nút Giữ chỗ giúp mình nhé.',
    ].join('\n');
  }

  if (/passenger|gender|full name|quick input|Nhập nhanh/i.test(message)) {
    return '1Booking chưa nhận đúng thông tin khách trong form.';
  }

  if (/timeout|locator|waitFor/i.test(message)) {
    return '1Booking chưa xác nhận kịp trạng thái trên màn hình.';
  }

  return 'Mình chưa hoàn tất được bước nhập khách hoặc giữ chỗ.';
}

function buildFlightSelectionRetryExample(input?: SelectMatchingFlightInput) {
  const airline = input?.airlineName ?? input?.airlineCode ?? 'Vietjet';
  const time = input?.departureTime ?? '13:30';

  if (input?.bookingClass) {
    return `chọn chuyến ${airline} ${time} hạng Deluxe`;
  }

  return `chọn chuyến ${airline} ${time}`;
}

function formatSelectionAirline(input: SelectMatchingFlightInput) {
  if (input.airlineName && input.airlineCode) {
    return `${input.airlineName} (${input.airlineCode})`;
  }

  return 'Chưa chỉ định';
}

function formatSelectionBookingClassShort(
  bookingClass: keyof typeof BOOKING_CLASS_LABELS | null,
) {
  return bookingClass
    ? `${BOOKING_CLASS_LABELS[bookingClass]} (${bookingClass})`
    : 'Chưa chỉ định';
}

function formatPnrDetailFlightBrand(flightCase: LocalFlightCase) {
  const selectedFlight = flightCase.selectedFlight;

  if (selectedFlight?.airlineName && selectedFlight.airlineCode) {
    return `${selectedFlight.airlineName} (${selectedFlight.airlineCode})`;
  }

  return selectedFlight?.airlineName ?? selectedFlight?.airlineCode ?? 'Chưa có';
}

function formatPnrDetailFlightTime(flightCase: LocalFlightCase) {
  const selectedFlight = flightCase.selectedFlight;

  if (!selectedFlight?.departureTime) {
    return 'Chưa có';
  }

  return selectedFlight.arrivalTime
    ? `${selectedFlight.departureTime} - ${selectedFlight.arrivalTime}`
    : selectedFlight.departureTime;
}
