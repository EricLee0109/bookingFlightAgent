/**
 * 1Booking dashboard URL used by all automation flows.
 *
 * The env var lets local operators override the domain, while the fallback keeps
 * the internal agent runnable without a frontend-style `NEXT_PUBLIC_*` config.
 */
export const ONE_BOOKING_URL =
  process.env.NEXT_PUBLIC_BOOKING_DOMAIN ?? 'https://pro.1booking.vn/dashboard';

export const ONE_BOOKING_STORAGE_STATE_PATH = 'auth/1booking-storage-state.json';

export const SCREENSHOT_DIR = 'screenshots';

export const ONE_BOOKING_VIEWPORT = {
  width: 1440,
  height: 900,
};

export const DEFAULT_TIMEOUT = 30000;
