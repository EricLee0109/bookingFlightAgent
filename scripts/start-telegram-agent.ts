import 'dotenv/config';
import { startTelegramAgent } from '../src/telegram/telegram-bot';
import { sanitizeAIError } from '../src/agent/ai-provider';

/**
 * Entry point for running Telegram Agent locally.
 *
 * Usage:
 * npx tsx scripts/start-telegram-agent.ts
 */
startTelegramAgent().catch((error) => {
  console.error('Failed to start Telegram Agent:', sanitizeAIError(error));
  process.exit(1);
});
