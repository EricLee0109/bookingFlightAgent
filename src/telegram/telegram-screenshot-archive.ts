import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { SCREENSHOT_DIR } from '../automation/1booking/constants';

export const TELEGRAM_DOWNLOAD_ARCHIVE_CONTENT_TYPE =
  'application/octet-stream';

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

/**
 * Builds explicit Telegram upload metadata for the screenshot archive.
 *
 * node-telegram-bot-api is moving toward requiring explicit file content types
 * for path uploads. ZIP archives are binary downloads, so we mark them as
 * application/octet-stream and keep the real filename for operator downloads.
 */
export function createTelegramScreenshotArchiveFileOptions(
  archivePath: string,
) {
  return {
    filename: path.basename(archivePath),
    contentType: TELEGRAM_DOWNLOAD_ARCHIVE_CONTENT_TYPE,
  };
}
