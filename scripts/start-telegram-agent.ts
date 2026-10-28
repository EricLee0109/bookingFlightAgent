import 'dotenv/config';
import { startTelegramAgent } from '../src/telegram/telegram-bot';
import { sanitizeAIError } from '../src/agent/ai-provider';

/**
 * Keeps the long-lived agent alive through background failures.
 *
 * Playwright and Telegram both emit rejections from promises nobody awaits
 * (locator handlers, polling retries, browser teardown). Node 22 treats an
 * unhandled rejection as fatal, so one flaky ad banner or socket reset would
 * kill the whole service and strand in-flight cases. These handlers log a
 * sanitized reason and keep the process serving the next operator message.
 */
function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (agent kept running):', {
      name: reason instanceof Error ? reason.name : typeof reason,
      message: sanitizeAIError(reason),
    });
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception (agent kept running):', {
      name: error.name,
      message: sanitizeAIError(error),
    });
  });
}

/**
 * Entry point for running Telegram Agent locally.
 *
 * Usage:
 * npx tsx scripts/start-telegram-agent.ts
 */
installCrashGuards();

startTelegramAgent().catch((error) => {
  // Startup failures are fatal on purpose: polling cannot recover from a
  // missing token or invalid configuration, so exiting lets a supervisor alert.
  console.error('Failed to start Telegram Agent:', sanitizeAIError(error));
  process.exit(1);
});
