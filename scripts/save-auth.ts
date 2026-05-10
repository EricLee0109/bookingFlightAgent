import { chromium } from 'playwright';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_URL,
  ONE_BOOKING_VIEWPORT,
} from './src/automation/1booking/constants';

async function main() {
  const browser = await chromium.launch({ headless: false }); //open chrome browser with headless mode false

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});