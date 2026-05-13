import { type Page } from 'playwright';

/**
 * Converts the contract ISO date format into the 1Booking date input format.
 *
 * Contract layer uses `YYYY-MM-DD` because it is stable for APIs and storage.
 * 1Booking UI expects `DD/MM/YYYY`, so this component owns that UI mapping.
 */
export function formatIsoDateForOneBooking(isoDate: string) {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error(`Invalid departureDate format: ${isoDate}. Expected YYYY-MM-DD.`);
  }

  const [, year, month, day] = match;

  return `${day}/${month}/${year}`;
}

/**
 * Selects the one-way departure date in the 1Booking search form.
 *
 * This component owns date-field interaction only. Round-trip return-date
 * handling belongs in a future automation component when MVP supports it.
 */
export async function selectDepartureDate(page: Page, departureDate: string) {
  const formattedDate = formatIsoDateForOneBooking(departureDate);
  const departureDateInput = page.getByPlaceholder('dd/mm/yyyy').first();

  await departureDateInput.click();
  await departureDateInput.press('Control+A');
  await departureDateInput.fill(formattedDate);
  await departureDateInput.press('Enter');

  await page.waitForFunction(
    (expectedValue) => {
      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder="dd/mm/yyyy"]',
      );

      return input?.value === expectedValue;
    },
    formattedDate,
    { timeout: 10000 },
  );
}
