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
    console.error('Telegram long polling error:', error);
  });

  bot.on('error', (error) => {
    console.error('Telegram bot runtime error:', error);
  });

  bot.on('message', async (message) => {
    try {
      await handleTelegramMessage(bot, message);
    } catch (error) {
      console.error('Telegram message handler crashed:', error);

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
      console.error('Telegram callback handler crashed:', error);

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
