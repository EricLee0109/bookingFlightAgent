import 'dotenv/config';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_VIEWPORT,
} from '../src/automation/1booking/constants';
import { formatIsoDateForOneBooking } from '../src/automation/1booking/dates';
import {
  extractFlightSelectionCandidates,
  openMatchingFlightPassengerForm,
  selectMatchingFlight,
} from '../src/automation/1booking/flight-selection';
import {
  fillAndAssertPassengerInformation,
  openPassengerHoldReview,
} from '../src/automation/1booking/hold-booking';
import {
  fillAndAssertHoldContactInformation,
  readOneBookingHoldContactInfoFromEnv,
} from '../src/automation/1booking/hold-contact';
import { searchFlights } from '../src/automation/1booking/flight-search';
import { takeFullPageScreenshot } from '../src/automation/1booking/screenshots';

test.setTimeout(240000);

const SEARCH_DEPARTURE_DATE = getFutureIsoDate(7);
const HOLD_ELIGIBLE_DEPARTURE_DATE = getFutureIsoDate(7);

/**
 * End-to-end coverage for the MVP 1Booking search automation.
 *
 * This test owns browser-level verification only. It uses saved auth state,
 * calls the automation flow, and asserts that a dated search returns results
 * plus a customer-facing screenshot.
 */
test('searches 1Booking flights with departure date', async ({ browser }) => {
  test.skip(
    !existsSync(ONE_BOOKING_STORAGE_STATE_PATH),
    `Missing saved auth state at ${ONE_BOOKING_STORAGE_STATE_PATH}. Run scripts/save-auth.ts first.`,
  );

  const context = await browser.newContext({
    storageState: ONE_BOOKING_STORAGE_STATE_PATH,
    viewport: ONE_BOOKING_VIEWPORT,
  });
  const page = await context.newPage();

  try {
    const result = await searchFlights(page, {
      fromAirportCode: 'SGN',
      fromAirportText: 'Sân bay Tân Sơn Nhất (SGN)',
      toAirportCode: 'HAN',
      toAirportText: 'Sân bay Nội Bài (HAN)',
      departureDate: SEARCH_DEPARTURE_DATE,
    });

    expect(formatIsoDateForOneBooking(SEARCH_DEPARTURE_DATE)).toMatch(
      /^\d{2}\/\d{2}\/\d{4}$/,
    );
    expect(result.success).toBe(true);
    expect(result.flightCount).toBeGreaterThan(0);
    expect(existsSync(result.screenshotPath)).toBe(true);
    expect(result.screenshotPaths.length).toBeGreaterThan(0);
    for (const screenshotPath of result.screenshotPaths) {
      expect(existsSync(screenshotPath)).toBe(true);
    }
  } catch (error) {
    await takeFullPageScreenshot(page, '1booking-search-e2e-failed.png');
    throw error;
  } finally {
    await context.close();
  }
});

/**
 * End-to-end coverage for selecting one refreshed flight result.
 *
 * The test first reads a real ECO candidate from 1Booking, then asks the
 * selection flow to rerun the search, match that candidate, click `Chọn ngay`,
 * click `Giữ chỗ`, and stop at the passenger information page.
 */
test('selects a matching ECO flight and opens passenger information page', async ({
  browser,
}) => {
  test.skip(
    !existsSync(ONE_BOOKING_STORAGE_STATE_PATH),
    `Missing saved auth state at ${ONE_BOOKING_STORAGE_STATE_PATH}. Run scripts/save-auth.ts first.`,
  );

  const searchInput = {
    fromAirportCode: 'SGN',
    fromAirportText: 'Sân bay Tân Sơn Nhất (SGN)',
    toAirportCode: 'HAN',
    toAirportText: 'Sân bay Nội Bài (HAN)',
    departureDate: HOLD_ELIGIBLE_DEPARTURE_DATE,
  };

  const context = await browser.newContext({
    storageState: ONE_BOOKING_STORAGE_STATE_PATH,
    viewport: ONE_BOOKING_VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await searchFlights(page, searchInput);

    const candidates = await extractFlightSelectionCandidates(page);
    const candidate = candidates[0];

    expect(candidate).toBeTruthy();

    if (!candidate) {
      throw new Error('Expected at least one candidate for selection test.');
    }

    const result = await selectMatchingFlight(page, searchInput, {
      caseId: 'BK-20260620-000000',
      airlineCode: candidate.airlineCode,
      airlineName: candidate.airlineName,
      departureTime: candidate.departureTime,
      bookingClass: candidate.bookingClass,
    });

    expect(result.selectedFlight.flightNumber).toBe(candidate.flightNumber);
    expect(result.selectedFlight.bookingClass).toBe(candidate.bookingClass);
    expect(existsSync(result.screenshotPath)).toBe(true);
    await expect(
      page.getByText(/Thông tin khách hàng|Thong tin khach hang/i).first(),
    ).toBeVisible();
  } catch (error) {
    await takeFullPageScreenshot(page, '1booking-selection-e2e-failed.png');
    throw error;
  } finally {
    await context.close();
  }
});

/**
 * End-to-end coverage for native quick passenger input without a real hold.
 *
 * The test opens the final review drawer, verifies the exact safe `Giữ chỗ`
 * CTA, and intentionally stops before clicking it to avoid a real booking.
 */
test('fills and asserts split passenger information before hold confirmation', async ({
  browser,
}) => {
  test.skip(
    !existsSync(ONE_BOOKING_STORAGE_STATE_PATH),
    `Missing saved auth state at ${ONE_BOOKING_STORAGE_STATE_PATH}. Run scripts/save-auth.ts first.`,
  );

  const searchInput = {
    fromAirportCode: 'SGN',
    fromAirportText: 'Sân bay Tân Sơn Nhất (SGN)',
    toAirportCode: 'DAD',
    toAirportText: 'Sân bay Đà Nẵng (DAD)',
    departureDate: HOLD_ELIGIBLE_DEPARTURE_DATE,
  };
  const context = await browser.newContext({
    storageState: ONE_BOOKING_STORAGE_STATE_PATH,
    viewport: ONE_BOOKING_VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await searchFlights(page, searchInput);

    const candidates = await extractFlightSelectionCandidates(page);
    const candidate = candidates[0];

    expect(candidate).toBeTruthy();

    if (!candidate) {
      throw new Error('Expected at least one candidate for passenger fill test.');
    }

    await openMatchingFlightPassengerForm(page, searchInput, {
      caseId: 'BK-20260620-000001',
      airlineCode: candidate.airlineCode,
      airlineName: candidate.airlineName,
      departureTime: candidate.departureTime,
      bookingClass: candidate.bookingClass,
    });
    await fillAndAssertPassengerInformation(page, {
      gender: 'F',
      lastName: 'NGUYEN',
      firstName: 'THI LANH',
      dob: null,
    });
    await fillAndAssertHoldContactInformation(
      page,
      readOneBookingHoldContactInfoFromEnv(),
    );

    await expect(
      page.getByRole('button', {
        name: /^Xác nhận$|^Xac nhan$/i,
      }),
    ).toBeEnabled();

    const reviewDrawer = await openPassengerHoldReview(page, {
      passengerInfo: {
        gender: 'F',
        lastName: 'NGUYEN',
        firstName: 'THI LANH',
        dob: null,
      },
      flightNumber: candidate.flightNumber,
    });

    await expect(
      reviewDrawer.getByRole('button', {
        name: /^Giữ chỗ$|^Giu cho$/i,
      }),
    ).toBeVisible();
    await expect(
      reviewDrawer.getByRole('button', {
        name: /^Xuất vé ngay$|^Xuat ve ngay$/i,
      }),
    ).toBeVisible();
  } catch (error) {
    await takeFullPageScreenshot(page, '1booking-passenger-fill-e2e-failed.png');
    throw error;
  } finally {
    await context.close();
  }
});

/**
 * Returns a local ISO date far enough out for 1Booking hold-enabled fares.
 */
function getFutureIsoDate(daysFromToday: number) {
  const date = new Date();

  date.setDate(date.getDate() + daysFromToday);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
