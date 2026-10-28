import { expect, test } from '@playwright/test';
import { closeOneBookingSearchOverlays, closeOneBookingPromotionPopup } from '../src/automation/1booking/waiters';

/** Mirrors the observed promotion DOM without contacting 1Booking. */
function fixture(delay = 0, stuck = false) {
  return `<input aria-label="Chọn điểm đi"><script>window.promotionShown = false; setTimeout(() => {
    const root = document.createElement('div'); root.className = 'ant-modal-root';
    root.innerHTML = '<div class="ant-modal-mask" style="position:fixed;inset:0;background:#0008;z-index:10"></div><div class="ant-modal-wrap" style="position:fixed;inset:0;z-index:11"><div class="ant-modal" role="dialog" style="position:absolute;top:100px;left:100px"><button aria-label="Đóng">X</button><div class="ant-carousel"><img src="/files/imagesliders/promotion.png"></div></div></div>';
    window.promotionShown = true;
    root.querySelector('button').onclick = () => { ${stuck ? '' : 'root.remove();'} };
    document.body.append(root);
  }, ${delay});</script>`;
}

test('closes a delayed promotion and releases the search input', async ({ page }) => {
  await page.setContent(fixture(100));
  await closeOneBookingSearchOverlays(page, 500);
  await expect(page.locator('.ant-modal-mask')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Chọn điểm đi' }).click({ timeout: 1000 });
  await expect(page.getByRole('textbox')).toBeFocused();
});

test('closes a promotion that appears after the initial overlay sweep', async ({ page }) => {
  await page.setContent(fixture(800));
  await closeOneBookingSearchOverlays(page, 20);

  await page.waitForFunction(() =>
    Boolean((window as Window & { promotionShown?: boolean }).promotionShown),
  );
  expect(await page.locator('.ant-modal[role="dialog"]').count()).toBe(1);

  await page.getByRole('textbox', { name: 'Chọn điểm đi' }).click({ timeout: 2000 });
  await expect(page.getByRole('textbox', { name: 'Chọn điểm đi' })).toBeFocused();
  await expect(page.locator('.ant-modal-mask')).toHaveCount(0);
});

test('reuses one promotion handler across repeated overlay sweeps', async ({ page }) => {
  const originalAddLocatorHandler = page.addLocatorHandler.bind(page);
  let registrationCount = 0;

  Object.defineProperty(page, 'addLocatorHandler', {
    configurable: true,
    value: async (...args: Parameters<typeof page.addLocatorHandler>) => {
      registrationCount += 1;
      return originalAddLocatorHandler(...args);
    },
  });

  await page.setContent(fixture(0));
  await closeOneBookingSearchOverlays(page, 500);

  await page.setContent(fixture(800));
  await closeOneBookingSearchOverlays(page, 20);
  await page.waitForFunction(() =>
    Boolean((window as Window & { promotionShown?: boolean }).promotionShown),
  );
  expect(registrationCount).toBe(1);

  await page.getByRole('textbox', { name: 'Chọn điểm đi' }).click({ timeout: 2000 });
  await expect(page.getByRole('textbox', { name: 'Chọn điểm đi' })).toBeFocused();
  await expect(page.locator('.ant-modal-mask')).toHaveCount(0);
});

test('does not close login or booking-review dialogs', async ({ page }) => {
  await page.setContent('<div class="ant-modal" role="dialog"><button aria-label="Đóng" onclick="window.closedWrongDialog=true">X</button><input type="password"></div>');
  expect(await closeOneBookingPromotionPopup(page, 100)).toBe(false);
  expect(await page.evaluate(() => (window as any).closedWrongDialog)).toBeUndefined();
  await expect(page.locator('input[type=password]')).toBeVisible();
});

test('reports a promotion that refuses to close instead of forcing search clicks', async ({ page }) => {
  await page.setContent(fixture(0, true));
  await expect(closeOneBookingPromotionPopup(page, 500)).rejects.toThrow('promotion popup remained open');
});

test('waits for the promotion mask and wrapper to disappear after content closes', async ({ page }) => {
  await page.setContent(fixture());
  await page.locator('.ant-modal button').waitFor();
  await page.locator('.ant-modal button').evaluate(button => {
    (button as HTMLButtonElement).onclick = () => {
      document.querySelector('.ant-modal')!.remove();
      setTimeout(() => {
        document.querySelector('.ant-modal-mask')!.remove();
        setTimeout(() => document.querySelector('.ant-modal-wrap')!.remove(), 100);
      }, 250);
    };
  });
  await closeOneBookingPromotionPopup(page, 500);
  expect(await page.locator('.ant-modal-mask').count()).toBe(0);
  expect(await page.locator('.ant-modal-wrap').count()).toBe(0);
  await page.getByRole('textbox', { name: 'Chọn điểm đi' }).click({ timeout: 1000 });
  await expect(page.getByRole('textbox', { name: 'Chọn điểm đi' })).toBeFocused();
});
