import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import {
  attachPlaywrightPageDiagnostics,
  launchConfiguredChromium,
} from '../browser-config';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_URL,
  ONE_BOOKING_VIEWPORT,
} from './constants';
import { closeOneBookingImportantNoticeDrawer } from './waiters';

export type OneBookingCredentials = {
  agentId: string;
  username: string;
  password: string;
};

export type OneBookingAuthRefreshResult = {
  ok: true;
  storageStatePath: string;
};

const ONE_BOOKING_ORIGIN = 'https://pro.1booking.vn';

/**
 * Error raised when automatic 1Booking login cannot safely refresh auth state.
 *
 * The message never includes credentials or token values.
 */
export class OneBookingAuthRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneBookingAuthRefreshError';
  }
}

/**
 * Reads and validates 1Booking login credentials from environment variables.
 */
export function readOneBookingCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OneBookingCredentials {
  const agentId = env.ONE_BOOKING_AGENT_ID?.trim();
  const username = env.ONE_BOOKING_USERNAME?.trim();
  const password = env.ONE_BOOKING_PASSWORD?.trim();
  const missingFields: string[] = [];

  if (!agentId) missingFields.push('ONE_BOOKING_AGENT_ID');
  if (!username) missingFields.push('ONE_BOOKING_USERNAME');
  if (!password) missingFields.push('ONE_BOOKING_PASSWORD');

  if (missingFields.length > 0) {
    throw new OneBookingAuthRefreshError(
      `Missing 1Booking credentials in .env: ${missingFields.join(', ')}.`,
    );
  }

  return {
    agentId: agentId ?? '',
    username: username ?? '',
    password: password ?? '',
  };
}

/**
 * Refreshes the saved 1Booking Playwright storage state through automatic login.
 *
 * Responsibilities:
 * - Use env-provided credentials.
 * - Fill only the 1Booking login form.
 * - Save the resulting storage state for future browser/API calls.
 * - Avoid logging credentials or access tokens.
 */
export async function refreshOneBookingAuthState(
  options: {
    storageStatePath?: string;
    credentials?: OneBookingCredentials;
    headless?: boolean;
  } = {},
): Promise<OneBookingAuthRefreshResult> {
  const storageStatePath =
    options.storageStatePath ?? ONE_BOOKING_STORAGE_STATE_PATH;
  const credentials = options.credentials ?? readOneBookingCredentialsFromEnv();
  const purpose = '1booking-auth-refresh';
  const { browser, launchId } = await launchConfiguredChromium({
    purpose,
    headlessOverride: options.headless,
  });

  try {
    const context = await browser.newContext({
      viewport: ONE_BOOKING_VIEWPORT,
    });
    const page = await context.newPage();
    attachPlaywrightPageDiagnostics(page, {
      launchId,
      purpose,
    });

    await page.goto(ONE_BOOKING_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await fillOneBookingLoginForm(page, credentials);
    await waitForOneBookingAuthenticatedState(page);
    await closeOneBookingImportantNoticeDrawer(page);
    await fs.mkdir(path.dirname(storageStatePath), {
      recursive: true,
    });
    await context.storageState({
      path: storageStatePath,
    });

    return {
      ok: true,
      storageStatePath,
    };
  } catch (error) {
    if (error instanceof OneBookingAuthRefreshError) {
      throw error;
    }

    throw new OneBookingAuthRefreshError(
      `Automatic 1Booking login failed. Please check .env credentials and 1Booking login state. ${
        error instanceof Error ? error.message : 'Unknown login error.'
      }`,
    );
  } finally {
    await browser.close();
  }
}

/**
 * Fills the current 1Booking login form with validated credentials.
 */
async function fillOneBookingLoginForm(
  page: Page,
  credentials: OneBookingCredentials,
) {
  const agentIdInput = page.getByPlaceholder(/mã đại lý|ma dai ly/i).first();
  const usernameInput = page
    .getByPlaceholder(/tên đăng nhập|ten dang nhap/i)
    .first();
  const passwordInput = page.locator('input[type="password"]').first();

  if (
    !(await agentIdInput
      .isVisible({
        timeout: 2000,
      })
      .catch(() => false))
  ) {
    await page
      .getByRole('button', { name: /^Đăng nhập$|^Dang nhap$/i })
      .first()
      .click();
  }

  await agentIdInput.waitFor({
    state: 'visible',
    timeout: 30000,
  });
  await usernameInput.waitFor({
    state: 'visible',
    timeout: 30000,
  });
  await passwordInput.waitFor({
    state: 'visible',
    timeout: 30000,
  });

  await agentIdInput.fill(credentials.agentId);
  await usernameInput.fill(credentials.username);
  await passwordInput.fill(credentials.password);

  await page.locator('button[form="loginForm"]').click();
}

/**
 * Waits until 1Booking has stored an access token and leaves the password form.
 */
async function waitForOneBookingAuthenticatedState(page: Page) {
  const timeoutMs = 60000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await hasSavedAccessToken(page)) {
      return;
    }

    if (await hasVisibleInvalidLoginMessage(page)) {
      throw new OneBookingAuthRefreshError(
        'Automatic 1Booking login failed. Please check .env credentials.',
      );
    }

    await page.waitForTimeout(1000);
  }

  throw new OneBookingAuthRefreshError(
    'Automatic 1Booking login did not reach an authenticated dashboard state.',
  );
}

async function hasSavedAccessToken(page: Page) {
  return page
    .evaluate((origin) => {
      const authentication = window.localStorage.getItem('authentication');

      if (window.location.origin !== origin || !authentication) {
        return false;
      }

      try {
        const parsed = JSON.parse(authentication) as {
          state?: {
            accessToken?: string;
          };
        };

        return Boolean(parsed.state?.accessToken);
      } catch {
        return false;
      }
    }, ONE_BOOKING_ORIGIN)
    .catch(() => false);
}

async function hasVisibleInvalidLoginMessage(page: Page) {
  const bodyText = await page
    .locator('body')
    .innerText({
      timeout: 500,
    })
    .catch(() => '');
  const normalizedText = normalizeVietnameseUiText(bodyText);

  return (
    normalizedText.includes('sai mat khau') ||
    normalizedText.includes('khong chinh xac') ||
    normalizedText.includes('dang nhap that bai')
  );
}

function normalizeVietnameseUiText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}
