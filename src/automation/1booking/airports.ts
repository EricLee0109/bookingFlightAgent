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