import { type Page } from 'playwright';
import { selectAirport } from './airports';
import { ONE_BOOKING_URL } from './constants';
import { selectDepartureDate } from './dates';
import {
  assertSearchFlightsAutomationInput,
  type SearchFlightsInput,
} from './search-flight-input';
import { submitFlightSearch } from './search-form';
import { takeFlightResultsScreenshot } from './screenshots';
import {
  throwIfOneBookingLoginModalVisible,
  waitForFlightResultsReady,
} from './waiters';

export type SearchFlightsResult = {
  success: boolean;
  flightCount: number;
  screenshotPath: string;
};

export type { SearchFlightsInput } from './search-flight-input';

/**
 * Runs the MVP one-way 1Booking flight search flow.
 *
 * This component owns browser automation orchestration only:
 * - open 1Booking
 * - select airports
 * - select departure date
 * - run search
 * - wait for results
 * - capture customer-facing result screenshot
 */
export async function searchFlights(
  page: Page,
  input: SearchFlightsInput,
): Promise<SearchFlightsResult> {
  assertSearchFlightsAutomationInput(input);

  await page.goto(ONE_BOOKING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await throwIfOneBookingLoginModalVisible(page);

  await selectAirport(page, {
    inputName: 'Chọn điểm đi',
    airportCode: input.fromAirportCode,
    airportText: input.fromAirportText,
  });

  await selectAirport(page, {
    inputName: 'Chọn điểm đến',
    airportCode: input.toAirportCode,
    airportText: input.toAirportText,
  });

  await selectDepartureDate(page, input.departureDate);

  await submitFlightSearch(page);
  await throwIfOneBookingLoginModalVisible(page, 5000);

  const flightCount = await waitForFlightResultsReady(page);

  const screenshotPath = await takeFlightResultsScreenshot(
    page,
    '1booking-search-flights.png',
  );

  return {
    success: true,
    flightCount,
    screenshotPath,
  };
}
