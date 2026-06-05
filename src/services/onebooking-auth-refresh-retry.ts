import { refreshOneBookingAuthState } from '../automation/1booking/auth';
import { isOneBookingAuthExpiredError } from '../automation/1booking/waiters';
import { appendLocalLog } from '../storage/local-log-store';

export type OneBookingAuthRefreshRetryOptions = {
  caseId?: string;
  onAuthRefresh?: () => Promise<void>;
  refreshAuthState?: typeof refreshOneBookingAuthState;
  appendLog?: typeof appendLocalLog;
};

/**
 * Tracks one auth-refresh attempt for one operator request.
 *
 * This helper keeps retry policy separate from search/selection/hold business
 * flow. It never retries after the caller says the action is irreversible.
 */
export class OneBookingAuthRefreshRetryController {
  authRefreshed = false;
  private refreshAttempted = false;
  private readonly caseId?: string;
  private readonly onAuthRefresh?: () => Promise<void>;
  private readonly refreshAuthState: typeof refreshOneBookingAuthState;
  private readonly appendLog: typeof appendLocalLog;

  constructor(options: OneBookingAuthRefreshRetryOptions = {}) {
    this.caseId = options.caseId;
    this.onAuthRefresh = options.onAuthRefresh;
    this.refreshAuthState = options.refreshAuthState ?? refreshOneBookingAuthState;
    this.appendLog = options.appendLog ?? appendLocalLog;
  }

  /**
   * Refreshes auth once when the error is an expired-session error.
   */
  async refreshIfAuthExpired(error: unknown, options: { irreversible: boolean }) {
    if (
      options.irreversible ||
      this.refreshAttempted ||
      !isOneBookingAuthExpiredError(error)
    ) {
      return false;
    }

    this.refreshAttempted = true;
    await this.onAuthRefresh?.();
    await this.appendLog({
      level: 'info',
      event: 'one_booking_auth_refresh_started',
      caseId: this.caseId,
      message: 'Refreshing 1Booking auth state after expired session.',
    });
    await this.refreshAuthState();
    this.authRefreshed = true;
    await this.appendLog({
      level: 'info',
      event: 'one_booking_auth_refresh_completed',
      caseId: this.caseId,
      message: '1Booking auth state refreshed successfully.',
    });

    return true;
  }
}
