import TelegramBot from 'node-telegram-bot-api';
import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';
import {
  readLocalFlightCase,
  type LocalFlightCase,
} from '../storage/local-case-store';
import {
  formatPnrDetailMessage,
  formatPnrDetailUnavailableMessage,
} from './telegram-formatters';

const PNR_DETAIL_CALLBACK_PATTERN = new RegExp(
  `^pnr:detail:(${BOOKING_CASE_REGEX.source})$`,
  'i',
);

export type PnrDetailCallbackPayload = {
  caseId: string;
};

/**
 * Parses the inline callback emitted by the PNR success detail button.
 */
export function parsePnrDetailCallbackData(
  callbackData: string | undefined,
): PnrDetailCallbackPayload | null {
  const match = callbackData?.match(PNR_DETAIL_CALLBACK_PATTERN);

  if (!match) {
    return null;
  }

  return {
    caseId: match[1].toUpperCase(),
  };
}

/**
 * Handles `Xem chi tiết` for held bookings using local case memory only.
 */
export async function tryHandleTelegramPnrDetailCallback(
  bot: TelegramBot,
  chatId: number,
  callbackData: string | undefined,
) {
  const payload = parsePnrDetailCallbackData(callbackData);

  if (!payload) {
    return false;
  }

  const flightCase = await readLocalFlightCase(payload.caseId);

  if (!flightCase || !isPnrDetailCaseComplete(flightCase)) {
    await bot.sendMessage(chatId, formatPnrDetailUnavailableMessage());
    return true;
  }

  await bot.sendMessage(chatId, formatPnrDetailMessage(flightCase), {
    parse_mode: 'HTML',
  });

  return true;
}

/**
 * Requires enough local case data to make the quick detail view useful.
 */
function isPnrDetailCaseComplete(flightCase: LocalFlightCase) {
  return Boolean(
    flightCase.pnrCode &&
      flightCase.selectedFlight &&
      flightCase.attachedPassenger,
  );
}
