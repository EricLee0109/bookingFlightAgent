import TelegramBot from 'node-telegram-bot-api';
import {
  runHybridSearchTurn,
  runHybridSearchPage,
  type HybridSearchAgentOptions,
  type HybridSearchTurnResult,
} from '../agent/hybrid-search-agent';
import { readAgentOrchestrationMode } from '../agent/booking-agent-policy';
import { isAllowedTelegramOperator } from './telegram-access';
import {
  readLocalAgentSettings,
  type AgentSettings,
} from '../storage/local-settings-store';

const PROCESSING_ACK_TIMEOUT_MS = 1_500;
const PROCESSING_ACK_TEXT = '⏳ Mình đã nhận yêu cầu, đang xử lý. Bạn chờ một chút nhé.';

export type TelegramHybridSearchDependencies = {
  runTurn?: (
    chatId: number,
    text: string,
    options?: HybridSearchAgentOptions,
  ) => Promise<HybridSearchTurnResult>;
  settingsReader?: () => Promise<AgentSettings>;
};

/** Keeps customer progress feedback bounded and isolated from the search turn. */
function sendProcessingAcknowledgement(
  bot: TelegramBot,
  chatId: number,
  replyToMessageId: number,
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (warning?: string) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (warning) console.warn(warning);
      resolve();
    };

    timeout = setTimeout(
      () => finish('Telegram processing acknowledgement timed out; continuing.'),
      PROCESSING_ACK_TIMEOUT_MS,
    );

    try {
      const sendResult = bot.sendMessage(chatId, PROCESSING_ACK_TEXT, {
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
      });
      Promise.resolve(sendResult).then(
        () => finish(),
        () => finish('Telegram processing acknowledgement failed; continuing.'),
      );
    } catch {
      finish('Telegram processing acknowledgement failed; continuing.');
    }
  });
}

/**
 * Pilot-only message entrypoint. A true return value tells the legacy handler
 * that it must not inspect the message further.
 */
export async function handleTelegramHybridSearchMessage(
  bot: TelegramBot,
  message: TelegramBot.Message,
  dependencies: TelegramHybridSearchDependencies = {},
) {
  if (readAgentOrchestrationMode() !== 'hybrid_search') return false;

  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;
  const text = message.text?.trim();

  if (!telegramUserId || !isAllowedTelegramOperator(telegramUserId)) {
    await bot.sendMessage(chatId, 'Bạn chưa có quyền sử dụng Agent này nhé.');
    return true;
  }

  // Settings and help are transport commands. They are intentionally handled
  // outside the pilot so no model call is needed for them.
  if (!text || /^\/start(?:\s|$)/i.test(text) || /^\/settings(?:\s|$)/i.test(text)) {
    return false;
  }
  if (/^\/help(?:\s|$)/i.test(text)) {
    await bot.sendMessage(
      chatId,
      [
        'Pilot tìm chuyến hỗ trợ request một chiều theo tuyến, ngày, giờ và hãng bay.',
        'Bạn có thể nói “giá rẻ nhất”, “sớm nhất” hoặc hỏi lại các chuyến đã tìm.',
        'Dùng nút Trang trước / Trang sau dưới ảnh để xem hết danh sách, mỗi trang tối đa 5 chuyến.',
        'Pilot chưa thực hiện chọn chuyến, nhập hành khách, giữ chỗ hay lấy PNR.',
      ].join('\n'),
    );
    return true;
  }
  if (/^\/hold(?:\s|$)/i.test(text)) {
    await bot.sendMessage(chatId, 'Pilot tìm chuyến chưa hỗ trợ giữ chỗ. Bạn dùng luồng giữ chỗ đã được operator phê duyệt giúp mình nhé.');
    return true;
  }

  const settingsReader = dependencies.settingsReader ?? readLocalAgentSettings;
  const settings = await settingsReader().catch(() => ({
    agentEnabled: false,
    autoSearchFlights: false,
    autoHoldBooking: false,
    requireConfirmationBeforeHold: true,
    debugMode: false,
  } satisfies AgentSettings));
  if (!settings.agentEnabled) {
    await bot.sendMessage(chatId, 'Agent hiện đang tắt. Bạn dùng /agent_on để bật lại nhé.');
    return true;
  }

  const result = await (dependencies.runTurn ?? runHybridSearchTurn)(chatId, text, {
    ownerTelegramUserId: telegramUserId,
    messageId: message.message_id,
    settingsReader,
    onProcessingStarted: () => sendProcessingAcknowledgement(
      bot,
      chatId,
      message.message_id,
    ),
  });

  // Telegram can redeliver an update after a network retry. The session store
  // claims message ids before running the model, so a duplicate produces no
  // second customer-facing answer or screenshot send.
  if (result.duplicate || result.status === 'duplicate') return true;

  await sendHybridSearchResult(bot, chatId, result);
  return true;
}

async function sendHybridSearchResult(bot: TelegramBot, chatId: number, result: HybridSearchTurnResult) {
  if (result.duplicate || result.status === 'duplicate') return;
  if (result.response) {
    await bot.sendMessage(chatId, result.response);
  }

  if (result.screenshotBatches.length > 0) {
    for (let index = 0; index < result.screenshotBatches.length; index += 1) {
      const batch = result.screenshotBatches[index];
      await bot.sendPhoto(chatId, batch.path, {
        caption: [
          `Ảnh lịch trình ${index + 1}/${result.screenshotBatches.length}, chỉ gồm chuyến trong danh sách đã lọc.`,
          `Snapshot: ${result.snapshotId ?? 'đã xác minh'}`,
          result.capturedAt ? `Thời điểm ghi nhận: ${result.capturedAt}` : '',
        ].filter(Boolean).join(' '),
      });
    }
  }

  const pagination = result.pagination;
  if (pagination && pagination.pageCount > 1) {
    const buttons: TelegramBot.InlineKeyboardButton[] = [];
    if (pagination.page > 0) buttons.push({ text: '⬅️ Trang trước', callback_data: `hs_page:${pagination.token}:${pagination.page - 1}` });
    if (pagination.page + 1 < pagination.pageCount) buttons.push({ text: 'Trang sau ➡️', callback_data: `hs_page:${pagination.token}:${pagination.page + 1}` });
    await bot.sendMessage(chatId, `Trang ${pagination.page + 1}/${pagination.pageCount} · ${pagination.total} chuyến trong danh sách.`, {
      reply_markup: { inline_keyboard: [buttons] },
    });
  }
}

/** Called after Telegram acknowledgement and operator allowlist checks. */
export async function handleTelegramHybridSearchPageCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  dependencies: {
    runPage?: typeof runHybridSearchPage;
    settingsReader?: () => Promise<AgentSettings>;
  } = {},
) {
  if (!query.data?.startsWith('hs_page:')) return false;
  const chatId = query.message?.chat.id;
  if (chatId === undefined) return true;
  if (!isAllowedTelegramOperator(query.from.id)) {
    await bot.sendMessage(chatId, 'Bạn chưa có quyền sử dụng Agent này nhé.');
    return true;
  }
  const match = /^hs_page:([a-f0-9-]{36}):(\d{1,6})$/.exec(query.data);
  if (!match) {
    await bot.sendMessage(chatId, 'Nút xem trang không hợp lệ. Bạn nhắn “xem lại kết quả” nhé.');
    return true;
  }
  const result = await (dependencies.runPage ?? runHybridSearchPage)(chatId, match[1], Number(match[2]), {
    ownerTelegramUserId: query.from.id,
    messageId: `callback:${query.id}`,
    settingsReader: dependencies.settingsReader,
  });
  await sendHybridSearchResult(bot, chatId, result);
  return true;
}
