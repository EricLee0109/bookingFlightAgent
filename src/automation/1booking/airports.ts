import { type Page } from 'playwright';
import { throwIfOneBookingLoginModalVisible } from './waiters';

type AnchorBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectAirportInput = {
  inputName: string;
  airportCode: string;
  airportText: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clicks a visible airport dropdown option by stable airport code first.
 *
 * 1Booking displays accented Vietnamese labels, while parser output may be
 * unaccented. Matching by IATA code avoids blocking on display-text differences.
 */
export async function clickVisibleAirportOption(
  page: Page,
  airportCode: string,
  airportText: string,
  anchorBox: AnchorBox,
) {
  const normalizedAirportCode = airportCode.trim().toUpperCase();
  const options = page.locator('p').filter({
    hasText: new RegExp(`\\b${escapeRegExp(normalizedAirportCode)}\\b`),
  });

  try {
    await page.waitForFunction(
      ({ anchor, code, text }) =>
        Array.from(document.querySelectorAll('p')).some((element) => {
          const rect = element.getBoundingClientRect();
          const isVisible = Boolean(rect.width || rect.height);
          const optionCenterX = rect.x + rect.width / 2;
          const anchorCenterX = anchor.x + anchor.width / 2;
          const verticallyBelowAnchor =
            rect.y >= anchor.y + anchor.height - 8 &&
            rect.y <= anchor.y + 520;
          const horizontallyNearAnchor =
            Math.abs(optionCenterX - anchorCenterX) <= 360;
          const optionText = element.textContent ?? '';
          const normalizedOptionText = optionText
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLowerCase();
          const normalizedExpectedText = text
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLowerCase();

          return (
            isVisible &&
            verticallyBelowAnchor &&
            horizontallyNearAnchor &&
            (optionText.includes(`(${code})`) ||
              normalizedOptionText.includes(normalizedExpectedText))
          );
        }),
      {
        anchor: anchorBox,
        code: normalizedAirportCode,
        text: airportText,
      },
      { timeout: 30000 },
    );
  } catch (error) {
    await throwIfOneBookingLoginModalVisible(page, 0);
    throw error;
  }

  const count = await options.count();

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);

    const optionBox = await option.boundingBox();

    if (
      (await option.isVisible()) &&
      optionBox &&
      isAirportOptionNearAnchor(optionBox, anchorBox)
    ) {
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
  await throwIfOneBookingLoginModalVisible(page, 1000);
  const anchorBox = await textbox.boundingBox();

  if (!anchorBox) {
    throw new Error(`Cannot locate airport textbox: ${input.inputName}`);
  }

  await clickVisibleAirportOption(
    page,
    input.airportCode,
    input.airportText,
    anchorBox,
  );
}

/**
 * Checks the nearest matching text node belongs to the active dropdown area.
 *
 * The dashboard can show airport codes in news/promotions too. This way can avoid
 * matching to the another active textbox unrelated page content.
 */
function isAirportOptionNearAnchor(optionBox: AnchorBox, anchorBox: AnchorBox) {
  const optionCenterX = optionBox.x + optionBox.width / 2;
  const anchorCenterX = anchorBox.x + anchorBox.width / 2;
  const verticallyBelowAnchor =
    optionBox.y >= anchorBox.y + anchorBox.height - 8 &&
    optionBox.y <= anchorBox.y + 520;
  const horizontallyNearAnchor = Math.abs(optionCenterX - anchorCenterX) <= 360;

  return verticallyBelowAnchor && horizontallyNearAnchor;
}
