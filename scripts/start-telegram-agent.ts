import 'dotenv/config';
import { startTelegramAgent } from '../src/telegram/telegram-bot';

/**
 * Entry point for running Telegram Agent locally.
 *
 * Usage:
 * npx tsx scripts/start-telegram-agent.ts
 */
startTelegramAgent().catch((error) => {
  console.error('Failed to start Telegram Agent:', error);
  process.exit(1);
});
