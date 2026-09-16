import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFlightCase, updateLocalFlightCase, type LocalFlightCase } from '../storage/local-case-store';
import { type AgentSettings } from '../storage/local-settings-store';

export type HoldApproval = {
  token: string;
  chatId: number;
  fingerprint: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'consumed';
  decidedBy?: number;
};

/** Binds approval to the exact saved route, fare and passenger details. */
export function holdFingerprint(flightCase: LocalFlightCase) {
  return createHash('sha256').update(JSON.stringify([
    flightCase.searchInput, flightCase.selectedFlight,
    flightCase.attachedPassenger?.id, flightCase.attachedPassengerInfo,
  ])).digest('hex');
}

/** Applies fail-closed settings, with human approval mandatory in SDK modes. */
export function requiresHoldApproval(settings: AgentSettings) {
  const sdkMode = !!process.env.AGENT_ORCHESTRATION_MODE && process.env.AGENT_ORCHESTRATION_MODE !== 'legacy';
  return sdkMode
    || settings.requireConfirmationBeforeHold !== false || settings.autoHoldBooking !== true;
}

/** Rejects terminal, stale and incomplete cases before preparing an approval. */
export function assertHoldReady(flightCase: LocalFlightCase) {
  if (flightCase.holdSubmittedAt || !['PASSENGER_INFO_CONFIRMED', 'AWAITING_HOLD_APPROVAL', 'FILL_PASSENGER_FAILED', 'HOLD_FAILED'].includes(flightCase.status)) {
    throw new Error('Case không còn sẵn sàng giữ chỗ. Kiểm tra trạng thái booking trước khi tiếp tục.');
  }
  if (!flightCase.searchInput || !flightCase.selectedFlight || !flightCase.attachedPassengerInfo) {
    throw new Error('Cần chọn chuyến và xác nhận hành khách trước khi giữ chỗ.');
  }
}

/** Creates or reuses a restart-safe review token; changing details invalidates it. */
export async function requestHoldApproval(caseId: string, chatId: number) {
  return withHoldClaim(caseId, () => requestHoldApprovalUnlocked(caseId, chatId));
}

/** Prepares a review while holding the same exclusive claim used by execution. */
async function requestHoldApprovalUnlocked(caseId: string, chatId: number) {
  const flightCase = await readLocalFlightCase(caseId);
  if (!flightCase) throw new Error('Không tìm thấy case.');
  assertHoldReady(flightCase);
  if (flightCase.telegramChatId !== chatId) throw new Error('Case không thuộc cuộc trò chuyện này.');
  const current = flightCase.holdApproval;
  if (current?.status === 'pending' && isCurrentApproval(flightCase, current)) return flightCase;
  return updateLocalFlightCase(flightCase, {
    status: 'AWAITING_HOLD_APPROVAL',
    holdApproval: {
      token: randomBytes(8).toString('hex'), chatId,
      fingerprint: holdFingerprint(flightCase),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), status: 'pending',
    },
  });
}

/** Checks expiry and saved details independently of the model or Telegram text. */
export function isCurrentApproval(flightCase: LocalFlightCase, approval: HoldApproval) {
  return approval.fingerprint === holdFingerprint(flightCase)
    && Date.parse(approval.expiresAt) > Date.now()
    && approval.chatId === flightCase.telegramChatId;
}

/** Serializes approval consumption across processes; a crash leaves a review marker. */
export async function withHoldClaim<T>(caseId: string, execute: () => Promise<T>) {
  // Validate the case ID before using it in any filesystem path.
  if (!await readLocalFlightCase(caseId)) throw new Error('Không tìm thấy case.');
  const directory = path.resolve('data/hold-claims');
  await fs.mkdir(directory, { recursive: true });
  const claimPath = path.join(directory, `${caseId}.lock`);
  let handle;
  try {
    handle = await fs.open(claimPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Case đang giữ chỗ hoặc bị gián đoạn. Kiểm tra booking hiện có trước khi thử lại.');
    }
    throw error;
  }
  try {
    return await execute();
  } finally {
    await handle.close();
    await fs.unlink(claimPath);
  }
}

/** Records an authenticated button decision and rejects replayed or changed reviews. */
export async function decideHoldApproval(caseId: string, token: string, chatId: number, userId: number, approved: boolean) {
  return withHoldClaim(caseId, async () => {
    const flightCase = (await readLocalFlightCase(caseId))!;
    assertHoldReady(flightCase);
    const approval = flightCase.holdApproval;
    if (!approval || approval.token !== token || approval.chatId !== chatId
      || approval.status !== 'pending' || !isCurrentApproval(flightCase, approval)) {
      throw new Error('Xác nhận đã hết hạn, đã xử lý hoặc thông tin đã thay đổi. Yêu cầu xác nhận giữ chỗ mới.');
    }
    return updateLocalFlightCase(flightCase, {
      status: 'PASSENGER_INFO_CONFIRMED',
      holdApproval: { ...approval, status: approved ? 'approved' : 'rejected', decidedBy: userId },
    });
  });
}

/** Consumes approval before browser launch; callers must hold the exclusive claim. */
export async function consumeHoldApproval(flightCase: LocalFlightCase, settings: AgentSettings) {
  assertHoldReady(flightCase);
  if (!settings.agentEnabled) throw new Error('Agent hiện đang tắt.');
  if (!requiresHoldApproval(settings)) return;
  const approval = flightCase.holdApproval;
  if (!approval || approval.status !== 'approved' || !isCurrentApproval(flightCase, approval)) {
    throw new Error('Cần xác nhận giữ chỗ cho đúng chuyến và hành khách trước khi tiếp tục.');
  }
  await updateLocalFlightCase(flightCase, { status: 'FILL_PASSENGER_RUNNING', holdApproval: { ...approval, status: 'consumed' } });
}
