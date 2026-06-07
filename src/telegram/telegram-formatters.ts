import {
  BOOKING_CLASS_LABELS,
  type FlightSelectionCandidate,
  type ParsedFlightRequest,
  type SelectMatchingFlightInput,
} from '../contracts/flight';
import { type PassengerMention } from '../contracts/passenger';
import { type PassengerProfile } from '../passengers/passenger-types';

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
export function formatSearchFailedMessage(message?: string) {
  return [
    '❌ Không thể tìm chuyến trên 1Booking.',
    '',
    message,
    message ? '' : null,
    'Có thể do:',
    '- Session 1Booking hết hạn.',
    '- UI 1Booking chưa load xong.',
    '- Selector thay đổi.',
    '- Không có chuyến phù hợp.',
    '',
    'Mình sẽ gửi screenshot lỗi bên dưới nếu có.',
  ]
    .filter(Boolean)
    .join('\n');
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
    `Mình hiểu "case này" là ${input.caseId}.`,
    '',
    `Giờ bay: ${input.departureTime}`,
    `Hãng: ${
      input.airlineName && input.airlineCode
        ? `${input.airlineName} (${input.airlineCode})`
        : 'Chưa chỉ định'
    }`,
    `Hạng đặt chỗ: ${formatSelectionBookingClass(input.bookingClass)}`,
    '',
    'Mình sẽ kiểm tra lại danh sách chuyến live trước khi chọn.',
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

/**
 * Formats the combined flow checkpoint before automatic fill and hold starts.
 */
export function formatCombinedSelectionPassengerReadyMessage(
  caseId: string,
  selectedFlight: FlightSelectionCandidate,
  profile: PassengerProfile,
) {
  return [
    `Đã chọn chuyến và gắn khách vào case ${caseId}.`,
    '',
    `Chuyến: ${selectedFlight.airlineName} ${selectedFlight.flightNumber}`,
    `Giờ bay: ${selectedFlight.departureTime}${
      selectedFlight.arrivalTime ? ` - ${selectedFlight.arrivalTime}` : ''
    }`,
    `Khách: ${profile.normalizedFullName}`,
    '',
    'Mình sẽ tự động nhập thông tin và giữ chỗ trên 1Booking.',
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
    `Đã lưu khách vào case ${caseId}.`,
    '',
    ...formatPassengerSummaryLines(profile),
    '',
    'Chưa chọn được chuyến. Vui lòng chọn lại chuyến bay cho case này.',
  ].join('\n');
}

/**
 * Formats a ready local passenger candidate before final operator confirmation.
 */
export function formatPassengerMatchedMessage(profile: PassengerProfile) {
  return [
    'Mình đã tìm thấy khách phù hợp:',
    '',
    ...formatPassengerSummaryLines(profile),
    '',
    'Vui lòng xác nhận trước khi gắn khách vào case.',
  ].join('\n');
}

/**
 * Formats an ambiguous local resolver result before candidate buttons.
 */
export function formatPassengerAmbiguousMessage(candidateCount: number) {
  return [
    `Mình tìm thấy ${candidateCount} khách có tên gần giống.`,
    '',
    'Vui lòng chọn đúng khách bên dưới.',
  ].join('\n');
}

/**
 * Formats a local resolver miss and requests manual passenger details.
 */
export function formatPassengerNotFoundMessage() {
  return [
    'Mình chưa tìm thấy khách phù hợp trong dữ liệu local.',
    '',
    'Vui lòng nhập họ tên đầy đủ và giới tính để mình lưu lại. Ngày sinh có thể bổ sung nếu cần.',
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
    `Mình đã tìm thấy ${profile.normalizedFullName}, nhưng còn thiếu thông tin.`,
    '',
    `Còn thiếu: ${labels.join(', ')}.`,
    '',
    'Bạn có thể gửi nhanh theo mẫu:',
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
  const labels = formatPassengerMissingFieldLabels(missingFields);
  const knownLines = formatKnownPassengerDraftLines(mention);
  const sampleLines = buildPassengerQuickInputExamples(mention);

  return [
    'Mình chưa đủ thông tin để lưu khách mới.',
    '',
    ...knownLines,
    knownLines.length > 0 ? '' : null,
    `Còn thiếu: ${labels.join(', ')}.`,
    '',
    'Vui lòng gửi theo một trong các mẫu:',
    ...sampleLines,
    '',
    'Ngày sinh không bắt buộc, chỉ thêm khi cần.',
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
    `Đã gắn khách vào case ${caseId}.`,
    '',
    ...formatPassengerSummaryLines(profile),
    '',
    'Trạng thái: passenger_ready.',
    'Mình sẽ tự động nhập form và tiến hành giữ chỗ trên 1Booking.',
  ].join('\n');
}

/**
 * Formats the automatic form-fill and hold progress message.
 */
export function formatPassengerHoldRunningMessage(caseId: string) {
  return `Đang nhập thông tin khách và giữ chỗ cho case ${caseId} trên 1Booking...`;
}

/**
 * Formats the VN-only DOB follow-up before automatic browser launch.
 */
export function formatPassengerHoldMissingDobMessage(profile: PassengerProfile) {
  return [
    `Chuyến Vietnam Airlines cần ngày sinh của ${profile.normalizedFullName} trước khi giữ chỗ.`,
    '',
    'Vui lòng bổ sung dạng: sinh 02/01/1995',
  ].join('\n');
}

/**
 * Formats successful hold confirmation and its extracted PNR when available.
 */
export function formatPassengerHoldSuccessMessage(
  caseId: string,
  pnrCode: string | null,
  pnrWarning?: string,
) {
  return [
    `Đã giữ chỗ thành công cho case ${caseId}.`,
    '',
    'Trạng thái: successful_hold.',
    pnrCode ? `PNR: ${pnrCode}` : 'PNR: Chưa extract được.',
    pnrWarning ? `Lưu ý: ${pnrWarning}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Formats the brief operator notice shown before automatic 1Booking re-login.
 */
export function formatOneBookingAuthRefreshStartedMessage() {
  return 'Phiên 1Booking đã hết hạn, mình đang tự đăng nhập lại...';
}

/**
 * Formats an uncertain post-submit hold state that must not be auto-retried.
 */
export function formatPassengerHoldNeedsReviewMessage(message: string) {
  return [
    'Đã gửi thao tác giữ chỗ lên 1Booking nhưng chưa thể xác nhận trạng thái cuối.',
    '',
    'Vui lòng kiểm tra đơn hàng hiện có trên 1Booking trước khi thử lại để tránh giữ chỗ trùng.',
    '',
    message,
  ].join('\n');
}

/**
 * Formats a failed automatic passenger fill or hold attempt.
 */
export function formatPassengerHoldFailedMessage(message: string) {
  return [
    'Không thể tự động giữ chỗ trên 1Booking.',
    '',
    message,
    '',
    'Mình sẽ gửi screenshot lỗi bên dưới nếu có.',
  ].join('\n');
}

/**
 * Formats a passenger AI parser failure for local operator troubleshooting.
 */
export function formatPassengerParserFailedMessage() {
  return [
    'Không thể phân tích thông tin khách bằng AI parser.',
    '',
    'Vui lòng kiểm tra OPENAI_API_KEY và thử lại.',
  ].join('\n');
}

/**
 * Formats the missing active-case instruction for passenger messages.
 */
export function formatPassengerCaseRequiredMessage() {
  return 'Vui lòng gửi kèm case BK-YYYYMMDD-HHMMSS hoặc chọn chuyến trước.';
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
  return missingFields.map((field) => {
    if (field === 'fullName') return 'họ tên đầy đủ';
    if (field === 'gender') return 'giới tính';
    if (field === 'dob') return 'ngày sinh';

    return field;
  });
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
