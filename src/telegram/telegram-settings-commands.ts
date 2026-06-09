import TelegramBot from 'node-telegram-bot-api';
import {
  readLocalAgentSettings,
  updateLocalAgentSettings,
} from '../storage/local-settings-store';

/**
 * Handles Telegram commands that read or update local agent settings.
 *
 * This component owns settings commands only. It does not parse flight requests
 * and it never calls Playwright automation.
 */
export async function handleTelegramSettingsCommand(
  bot: TelegramBot,
  message: TelegramBot.Message,
) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (!text?.startsWith('/')) {
    return false;
  }

  if (text === '/settings') {
    const settings = await readLocalAgentSettings();

    await bot.sendMessage(
      chatId,
      [
        '⚙️ Cài đặt Agent hiện tại:',
        `agentEnabled: ${settings.agentEnabled}`,
        `autoSearchFlights: ${settings.autoSearchFlights}`,
        `autoHoldBooking: ${settings.autoHoldBooking}`,
        `requireConfirmationBeforeHold: ${settings.requireConfirmationBeforeHold}`,
        `debugMode: ${settings.debugMode}`,
      ].join('\n'),
    );

    return true;
  }

  if (text === '/agent_on' || text === '/agent_off') {
    const settings = await updateLocalAgentSettings({
      agentEnabled: text === '/agent_on',
    });

    await bot.sendMessage(chatId, `✅ agentEnabled: ${settings.agentEnabled}`);
    return true;
  }

  if (text === '/auto_search_on' || text === '/auto_search_off') {
    const settings = await updateLocalAgentSettings({
      autoSearchFlights: text === '/auto_search_on',
    });

    await bot.sendMessage(chatId, `✅ autoSearchFlights: ${settings.autoSearchFlights}`);
    return true;
  }

  if (text === '/debug_on' || text === '/debug_off') {
    const settings = await updateLocalAgentSettings({
      debugMode: text === '/debug_on',
    });

    await bot.sendMessage(chatId, `✅ debugMode: ${settings.debugMode}`);
    return true;
  }

  return false;
}
