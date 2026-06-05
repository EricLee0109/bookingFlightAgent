import fs from 'node:fs/promises';
import { ONE_BOOKING_STORAGE_STATE_PATH } from '../automation/1booking/constants';
import { OneBookingAuthExpiredError } from '../automation/1booking/waiters';

type PlaywrightStorageState = {
  origins?: Array<{
    origin?: string;
    localStorage?: Array<{
      name?: string;
      value?: string;
    }>;
  }>;
};

/**
 * Reads the 1Booking access token from the saved Playwright auth state.
 *
 * The token is never logged or included in thrown errors. If this fails, the
 * operator needs to refresh local auth with `pnpm run save-auth:dev`.
 */
export async function readOneBookingAccessToken(
  storageStatePath = ONE_BOOKING_STORAGE_STATE_PATH,
) {
  const rawStorageState = await fs.readFile(storageStatePath, 'utf8').catch(() => {
    throw new OneBookingAuthExpiredError(
      `Missing 1Booking auth state. Refresh 1Booking auth before calling 1Booking APIs.`,
    );
  });

  let storageState: PlaywrightStorageState;

  try {
    storageState = JSON.parse(rawStorageState) as PlaywrightStorageState;
  } catch {
    throw new OneBookingAuthExpiredError(
      `Invalid 1Booking auth state JSON. Refresh 1Booking auth before calling 1Booking APIs.`,
    );
  }

  const authLocalStorageValue = storageState.origins
    ?.find((origin) => origin.origin === 'https://pro.1booking.vn')
    ?.localStorage?.find((item) => item.name === 'authentication')?.value;

  if (!authLocalStorageValue) {
    throw new OneBookingAuthExpiredError(
      `Missing 1Booking authentication state. Refresh 1Booking auth before calling 1Booking APIs.`,
    );
  }

  try {
    const authentication = JSON.parse(authLocalStorageValue) as {
      state?: {
        accessToken?: string;
      };
    };
    const accessToken = authentication.state?.accessToken;

    if (!accessToken) {
      throw new Error('missing token');
    }

    return accessToken;
  } catch {
    throw new OneBookingAuthExpiredError(
      `Missing 1Booking access token. Refresh 1Booking auth before calling 1Booking APIs.`,
    );
  }
}
