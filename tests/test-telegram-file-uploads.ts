import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import TelegramBot from 'node-telegram-bot-api';
import { startTelegramAgent } from '../src/telegram/telegram-bot';
import { createTelegramScreenshotArchiveFileOptions } from '../src/telegram/telegram-screenshot-archive';

/** Runs the installed upload formatter after actual startup, without HTTP requests. */
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-upload-contract-'));
  const originalPolling = TelegramBot.prototype.startPolling;
  const originalEnv = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    mode: process.env.AGENT_ORCHESTRATION_MODE,
    upload: process.env.NTBA_FIX_350,
  };
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on('warning', onWarning);
  TelegramBot.prototype.startPolling = async () => {};
  process.env.TELEGRAM_BOT_TOKEN = 'synthetic-offline-token';
  process.env.AGENT_ORCHESTRATION_MODE = 'legacy';
  delete process.env.NTBA_FIX_350;

  try {
    await startTelegramAgent();
    const bot = new TelegramBot('synthetic-offline-token', { polling: false });
    const format = (bot as any)._formatSendData.bind(bot);
    const pngPath = path.join(directory, 'results.png');
    const zipPath = path.join(directory, 'results.zip');
    const unknownPath = path.join(directory, 'results.unknownextension');
    await fs.writeFile(pngPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    await fs.writeFile(zipPath, Buffer.from('504b0506', 'hex'));
    await fs.writeFile(unknownPath, Buffer.from('offline test'));
    const cases = [
      { type: 'photo', file: pngPath, options: {}, expected: 'image/png' },
      { type: 'document', file: zipPath, options: createTelegramScreenshotArchiveFileOptions(zipPath), expected: 'application/octet-stream' },
      { type: 'document', file: unknownPath, options: {}, expected: 'application/octet-stream' },
    ];
    for (const item of cases) {
      const [form] = format(item.type, item.file, item.options);
      const upload = form[item.type];
      upload.value.resume();
      await finished(upload.value);
      assert.equal(upload.options.filename, path.basename(item.file));
      assert.equal(upload.options.contentType, item.expected);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.filter(warning => /content-type of files/.test(warning.message)).length, 0);
    assert.ok(process.env.NTBA_FIX_350, 'startup opts into supported modern upload behavior');
    console.log('Telegram upload contracts passed: PNG MIME, archive metadata, unknown-file fallback, no legacy content-type warning. No network calls.');
  } finally {
    TelegramBot.prototype.startPolling = originalPolling;
    process.removeListener('warning', onWarning);
    for (const [key, value] of [
      ['TELEGRAM_BOT_TOKEN', originalEnv.token],
      ['AGENT_ORCHESTRATION_MODE', originalEnv.mode],
      ['NTBA_FIX_350', originalEnv.upload],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
