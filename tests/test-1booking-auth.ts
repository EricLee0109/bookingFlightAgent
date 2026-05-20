import { createOneBookingBrowserSession } from '../src/automation/1booking/browser';
import { searchFlights } from '../src/automation/1booking/flight-search';
import { takeFullPageScreenshot } from '../src/automation/1booking/screenshots';

async function main() {
  const { browser, page } = await createOneBookingBrowserSession();

  try {
    const result = await searchFlights(page, {
      fromAirportCode: 'SGN',
      fromAirportText: 'Sân bay Tân Sơn Nhất (SGN)',
      toAirportCode: 'HAN',
      toAirportText: 'Sân bay Nội Bài (HAN)',
      departureDate: '2026-05-13',
    });

    console.log(
      `Found ${result.flightCount} flight result(s). Screenshot(s) saved at: ${result.screenshotPaths.join(', ')}`,
    );
  } catch (error) {
    console.error('1Booking search failed:', error);

    await takeFullPageScreenshot(
      page,
      '1booking-search-failed.png',
    );

    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
