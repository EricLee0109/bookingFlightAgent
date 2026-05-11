import { type Page } from 'playwright';
import { ONE_BOOKING_URL } from './constants';
import { selectAirport } from './airports';
import { waitForFlightResultsReady } from './waiters';
import { takeFlightResultsScreenshot } from './screenshots';

export type SearchFlightsInput = {
    fromAirportCode: string;
    fromAirportText: string;
    toAirportCode: string;
    toAirportText: string;
};

export type SearchFlightsResult = {
    success: boolean;
    flightCount: number;
    screenshotPath: string;
};

export async function searchFlights(
    page: Page,
    input: SearchFlightsInput,
): Promise<SearchFlightsResult> {
    await page.goto(ONE_BOOKING_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });

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

    // Finds the Search Button to search flights
    await page.locator('button.ant-btn.w-20.xl\\:flex').click(); //technical debt - if have better way to find the search button, fix later

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
