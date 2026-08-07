import TelegramBot from 'node-telegram-bot-api';
import { handleTelegramMessage } from './telegram-message-handler';
import { handleTelegramCallbackQuery } from './telegram-passenger-message-handler';

/**
 * Starts the Telegram Agent using long polling.
 *
 * Responsibilities:
 * - Connect to Telegram Bot API using TELEGRAM_BOT_TOKEN.
 * - Listen for incoming Telegram messages.
 * - Delegate business logic to `handleTelegramMessage`.
 *
 * MVP note:
 * - Long polling is used for local development.
 * - Lean internal-agent production can keep long polling while there is no
 *   public webhook server.
 */
export async function startTelegramAgent() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN in environment variables.');
  }

  const bot = new TelegramBot(token, {
    polling: true,
  });

  bot.on('polling_error', (error) => {
    console.error(
      'Telegram long polling error:',
      toSafeTelegramError(error, token),
    );
  });

  bot.on('error', (error) => {
    console.error(
      'Telegram bot runtime error:',
      toSafeTelegramError(error, token),
    );
  });

  bot.on('message', async (message) => {
    try {
      await handleTelegramMessage(bot, message);
    } catch (error) {
      console.error(
        'Telegram message handler crashed:',
        toSafeTelegramError(error, token),
      );

      if (message.chat?.id) {
        await bot.sendMessage(
          message.chat.id,
          '⚠️ Mình gặp lỗi ngoài ý muốn khi xử lý request. Bạn kiểm tra log local giúp mình nhé.',
        );
      }
    }
  });

  bot.on('callback_query', async (callbackQuery) => {
    try {
      await handleTelegramCallbackQuery(bot, callbackQuery);
    } catch (error) {
      console.error(
        'Telegram callback handler crashed:',
        toSafeTelegramError(error, token),
      );

      if (callbackQuery.message?.chat.id) {
        await bot.sendMessage(
          callbackQuery.message.chat.id,
          '⚠️ Mình gặp lỗi khi xử lý lựa chọn khách. Bạn kiểm tra log local giúp mình nhé.',
        );
      }
    }
  });

  console.log('Telegram Agent is running in long polling mode...');
}

/**
 * Keeps Telegram errors useful without logging request options, headers, full
 * stack objects or API URLs that may contain the bot token.
 */
export function toSafeTelegramError(error: unknown, botToken?: string) {
  const errorRecord = toUnknownRecord(error);
  const causeRecord = toUnknownRecord(errorRecord?.cause);

  return {
    name:
      error instanceof Error
        ? error.name
        : readSafeErrorField(errorRecord, 'name') ?? 'UnknownError',
    code: readSafeErrorField(errorRecord, 'code'),
    message: redactTelegramToken(
      error instanceof Error ? error.message : String(error),
      botToken,
    ),
    causeCode: readSafeErrorField(causeRecord, 'code'),
  };
}

function toUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSafeErrorField(
  value: Record<string, unknown> | undefined,
  field: string,
) {
  const fieldValue = value?.[field];
  return typeof fieldValue === 'string' || typeof fieldValue === 'number'
    ? fieldValue
    : undefined;
}

function redactTelegramToken(value: string, botToken?: string) {
  let redactedValue = value;

  if (botToken) {
    redactedValue = redactedValue.replaceAll(botToken, '[REDACTED]');
  }

  return redactedValue
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[REDACTED]')
    .replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .slice(0, 1000);
}
