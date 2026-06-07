import TelegramBot from 'node-telegram-bot-api';
import { BOOKING_CASE_REGEX } from '../automation/1booking/constants';
import { recoverHeldBookingCase } from '../services/passenger-hold-recovery-service';
import {
  formatHoldRecoveryFailedMessage,
  formatHoldRecoveryParseFailedMessage,
  formatPassengerHoldSuccessMessage,
} from './telegram-formatters';

const HOLD_RECOVERY_PATTERN = new RegExp(
  `^recover\\s+(${BOOKING_CASE_REGEX.source})\\s+pnr\\s+([a-z0-9]+)$`,
  'i',
);

export type ParsedHoldRecoveryMessage =
  | {
      isRecoveryMessage: false;
    }
  | {
      isRecoveryMessage: true;
      ok: false;
      message: string;
    }
  | {
      isRecoveryMessage: true;
      ok: true;
      caseId: string;
      pnrCode: string;
    };

/**
 * Parses the explicit operator-only hold recovery message.
 *
 * Example: `recover BK-20260602-145601 PNR HXGUQ9`
 */
export function parseHoldRecoveryMessage(
  rawMessage: string,
): ParsedHoldRecoveryMessage {
  if (!/^recover\b/i.test(rawMessage.trim())) {
    return {
      isRecoveryMessage: false,
    };
  }

  const match = rawMessage.trim().match(HOLD_RECOVERY_PATTERN);

  if (!match) {
    return {
      isRecoveryMessage: true,
      ok: false,
      message: 'invalid_recovery_syntax',
    };
  }

  return {
    isRecoveryMessage: true,
    ok: true,
    caseId: match[1].toUpperCase(),
    pnrCode: match[2].toUpperCase(),
  };
}

/**
 * Reconciles a reviewed held booking before normal Telegram message routing.
 *
 * This transport component delegates local-state mutation to the recovery
 * service and never invokes Playwright.
 */
export async function tryHandleTelegramHoldRecoveryMessage(
  bot: TelegramBot,
  chatId: number,
  rawMessage: string,
) {
  const parsed = parseHoldRecoveryMessage(rawMessage);

  if (!parsed.isRecoveryMessage) {
    return false;
  }

  if (!parsed.ok) {
    await bot.sendMessage(chatId, formatHoldRecoveryParseFailedMessage());
    return true;
  }

  const result = await recoverHeldBookingCase(parsed);

  if (!result.ok) {
    await bot.sendMessage(chatId, formatHoldRecoveryFailedMessage(result.message));
    return true;
  }

  await bot.sendMessage(
    chatId,
    formatPassengerHoldSuccessMessage(result.caseId, result.pnrCode),
  );

  return true;
}
