import { type Page } from 'playwright';

export type SelectAirportInput = {
  inputName: string;
  airportCode: string;
  airportText: string;
};

export async function clickVisibleAirportOption(page: Page, airportText: string) {
  const options = page.locator('p').filter({
    hasText: airportText,
  });

  await page.waitForFunction(
    (text) =>
      Array.from(document.querySelectorAll('p')).some((element) => {
        const isVisible = Boolean(
          element.offsetWidth ||
            element.offsetHeight ||
            element.getClientRects().length,
        );

        return isVisible && element.textContent?.includes(text);
      }),
    airportText,
    { timeout: 10000 },
  );

  const count = await options.count();

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);

    if (await option.isVisible()) {
      await option.click();
      return;
    }
  }

  throw new Error(`Không tìm thấy airport option đang hiển thị: ${airportText}`);
}

export async function selectAirport(page: Page, input: SelectAirportInput) {
  const textbox = page.getByRole('textbox', {
    name: input.inputName,
  });

  await textbox.click();
  await textbox.fill(input.airportCode);

  await clickVisibleAirportOption(page, input.airportText);
}
