import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { SCREENSHOT_DIR } from '../automation/1booking/constants';

/**
 * Creates one ZIP file containing all customer-facing result screenshots.
 *
 * Telegram cannot expose local filesystem links safely. Sending this archive as
 * a document gives operators a single "Download All Files" attachment.
 */
export async function createTelegramScreenshotArchive(
  caseId: string,
  screenshotPaths: string[],
) {
  const files: Record<string, Uint8Array> = {};

  for (let index = 0; index < screenshotPaths.length; index++) {
    const screenshotPath = screenshotPaths[index];
    const fileBuffer = await fs.readFile(screenshotPath);
    const fileName = `flight-results-${index + 1}.png`;

    files[fileName] = new Uint8Array(fileBuffer);
  }

  await fs.mkdir(SCREENSHOT_DIR, {
    recursive: true,
  });

  const archivePath = path.join(SCREENSHOT_DIR, `${caseId}-flight-results.zip`);
  const zipBuffer = Buffer.from(zipSync(files));

  await fs.writeFile(archivePath, zipBuffer);

  return archivePath;
}
