import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  ONE_BOOKING_STORAGE_STATE_PATH,
  ONE_BOOKING_VIEWPORT,
} from '../src/automation/1booking/constants';
import { formatIsoDateForOneBooking } from '../src/automation/1booking/dates';
import {
  extractFlightSelectionCandidates,
  selectMatchingFlight,
} from '../src/automation/1booking/flight-selection';
import { searchFlights } from '../src/automation/1booking/flight-search';
import { takeFullPageScreenshot } from '../src/automation/1booking/screenshots';

test.setTimeout(240000);

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
      departureDate: '2026-05-13',
    });

    expect(formatIsoDateForOneBooking('2026-05-13')).toBe('13/05/2026');
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
    departureDate: '2026-06-20',
  };

  const context = await browser.newContext({
    storageState: ONE_BOOKING_STORAGE_STATE_PATH,
    viewport: ONE_BOOKING_VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await searchFlights(page, searchInput);

    const candidates = await extractFlightSelectionCandidates(page);
    const candidate = candidates.find(
      (flightCandidate) => flightCandidate.bookingClass === 'ECO',
    );

    expect(candidate).toBeTruthy();

    if (!candidate) {
      throw new Error('Expected at least one ECO candidate for selection test.');
    }

    const result = await selectMatchingFlight(page, searchInput, {
      caseId: 'BK-20260620-000000',
      airlineCode: candidate.airlineCode,
      airlineName: candidate.airlineName,
      departureTime: candidate.departureTime,
      bookingClass: 'ECO',
    });

    expect(result.selectedFlight.flightNumber).toBe(candidate.flightNumber);
    expect(result.selectedFlight.bookingClass).toBe('ECO');
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
