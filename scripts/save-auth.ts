import 'dotenv/config';
import { chromium } from 'playwright';
import { getPlaywrightLaunchOptions } from '../src/automation/browser-config';
import { refreshOneBookingAuthState } from '../src/automation/1booking/auth';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_URL,
  ONE_BOOKING_VIEWPORT,
} from '../src/automation/1booking/constants';

/**
 * Saves 1Booking auth state for local automation.
 *
 * Default mode performs automatic env-based login. Use `--manual` only when
 * 1Booking changes the login UI or requires human verification.
 */
async function main() {
  if (!process.argv.includes('--manual')) {
    const result = await refreshOneBookingAuthState();

    console.log(`Storage state saved at: ${result.storageStatePath}`);
    return;
  }

  const browser = await chromium.launch(getPlaywrightLaunchOptions());

  const context = await browser.newContext({
    viewport: ONE_BOOKING_VIEWPORT,
  });

  const page = await context.newPage();

  await page.goto(ONE_BOOKING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  console.log('Login thủ công trong browser Playwright.');
  console.log('Sau khi login xong và vào dashboard, quay lại terminal rồi nhấn Enter.');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await context.storageState({
    path: ONE_BOOKING_STORAGE_STATE_PATH,
  });

  console.log(`Storage state saved at: ${ONE_BOOKING_STORAGE_STATE_PATH}`);

  await browser.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
