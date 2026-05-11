import { type Page } from 'playwright';

function parseFlightResultCount(text: string) {
  const match = text.match(/tìm thấy\s+(\d+)\s+kết quả/i);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

export async function waitForLoadingOverlayToDisappear(page: Page) {
  const possibleLoadingOverlays = [
    '.ant-spin',
    '.ant-spin-spinning',
    '[aria-busy="true"]',
    '[role="progressbar"]',
    'text=Đang tải',
    'text=Loading',
  ];

  for (const selector of possibleLoadingOverlays) {
    const loader = page.locator(selector).first();

    try {
      if (await loader.isVisible({ timeout: 1000 })) {
        await loader.waitFor({
          state: 'hidden',
          timeout: 30000,
        });
      }
    } catch {
      // Ignore missing loader selectors.
    }
  }
}

export async function waitForFlightResultsReady(page: Page) {
  await waitForLoadingOverlayToDisappear(page);

  const resultSummary = page
    .locator('div')
    .filter({
      hasText: /tìm thấy\s+\d+\s+kết quả/i,
    })
    .last();

  await resultSummary.waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const summaryText = await resultSummary.innerText();
  const countFromSummary = parseFlightResultCount(summaryText);

  if (countFromSummary === null) {
    throw new Error(`Could not parse flight result count from: ${summaryText}`);
  }

  if (countFromSummary < 1) {
    throw new Error('Expected at least 1 flight result, but found 0.');
  }

  const flightOptions = page
    .getByRole('list', { name: /Single ticket options/i })
    .locator(':scope > div');

  await flightOptions.first().waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const visibleFlightOptionCount = await flightOptions.evaluateAll((elements) =>
    elements.filter(
      (element) =>
        element instanceof HTMLElement &&
        Boolean(
          element.offsetWidth ||
            element.offsetHeight ||
            element.getClientRects().length,
        ),
    ).length,
  );

  if (visibleFlightOptionCount !== countFromSummary) {
    throw new Error(
      `Flight result count mismatch. Summary says ${countFromSummary}, but found ${visibleFlightOptionCount} visible option(s).`,
    );
  }

  await page.waitForLoadState('networkidle', {
    timeout: 10000,
  }).catch(() => null);

  // Small render-stabilization delay before screenshot.
  await page.waitForTimeout(1500);

  return countFromSummary;
}
