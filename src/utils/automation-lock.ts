let lockedBy: string | null = null;

export class AutomationLockBusyError extends Error {
  constructor(readonly lockedBy: string) {
    super(`SakuraBot đang xử lý ${lockedBy}. Bạn gửi lại sau khi tác vụ này hoàn tất giúp mình nhé.`);
    this.name = 'AutomationLockBusyError';
  }
}

/**
 * Checks whether 1Booking automation is already running in this Node process.
 *
 * This is an in-memory MVP guard only. It prevents overlapping local Playwright
 * sessions without adding Redis or BullMQ.
 */
export function isAutomationLocked() {
  return lockedBy !== null;
}

/**
 * Runs one automation task while holding an in-memory lock.
 *
 * If another Telegram request is already using Playwright, this helper fails
 * fast with a clear message instead of opening a second browser session.
 */
export async function runWithAutomationLock<T>(
  lockName: string,
  task: () => Promise<T>,
) {
  if (lockedBy) {
    throw new AutomationLockBusyError(lockedBy);
  }

  lockedBy = lockName;

  try {
    return await task();
  } finally {
    lockedBy = null;
  }
}
