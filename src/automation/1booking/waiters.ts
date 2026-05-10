import { type Page } from 'playwright';

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
  const flightCards = page.locator('div').filter({
    hasText: /Bay thẳng|HAN\s*-\s*SGN|SGN\s*-\s*HAN/i,
  });

  await flightCards.first().waitFor({
    state: 'visible',
    timeout: 30000,
  });

  const count = await flightCards.count();

  if (count < 1) {
    throw new Error('Expected at least 1 flight result, but found 0.');
  }

  await waitForLoadingOverlayToDisappear(page);

  await page.waitForLoadState('networkidle', {
    timeout: 10000,
  }).catch(() => null);

  // Small render-stabilization delay before screenshot.
  await page.waitForTimeout(1500);

  return count;
}