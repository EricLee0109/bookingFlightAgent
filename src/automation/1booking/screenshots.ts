import fs from 'node:fs/promises';
import { type Page } from 'playwright';
import { SCREENSHOT_DIR } from './constants';

export async function ensureScreenshotDir() {
  await fs.mkdir(SCREENSHOT_DIR, {
    recursive: true,
  });
}

export async function takeFullPageScreenshot(page: Page, fileName: string) {
  await ensureScreenshotDir();

  const path = `${SCREENSHOT_DIR}/${fileName}`;

  await page.screenshot({
    path,
    fullPage: true,
  });

  return path;
}