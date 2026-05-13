import TelegramBot from 'node-telegram-bot-api';
import { handleTelegramMessage } from './telegram-message-handler';

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
 * - Production should later move to webhook + NestJS API + queue.
 */
export async function startTelegramAgent() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN in environment variables.');
  }

  const bot = new TelegramBot(token, {
    polling: true,
  });

  bot.on('message', async (message) => {
    try {
      await handleTelegramMessage(bot, message);
    } catch (error) {
      console.error('Telegram message handler crashed:', error);

      if (message.chat?.id) {
        await bot.sendMessage(
          message.chat.id,
          '❌ Có lỗi ngoài ý muốn khi xử lý request. Vui lòng kiểm tra log local.',
        );
      }
    }
  });

  console.log('Telegram Agent is running in long polling mode...');
}
