import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * Regression test for the 1Booking promotion popup close control.
 *
 * 1Booking renders the banner close button as a round icon labelled "Close",
 * not a text button "Đóng". The previous implementation only looked for the
 * Vietnamese text, so every banner left the mask covering the search form and
 * the agent crashed. These tests mount realistic Ant Design modal markup and
 * require the real dismissal helper to close it.
 */

let browser: Browser;

async function mountPromotion(
  page: Page,
  closeMarkup: string,
) {
  await page.setContent(`<!doctype html><html><body>
    <div id="app" style="height:100vh;background:#fff">
      <input placeholder="Chọn điểm đi" style="width:200px;height:32px" />
    </div>
  </body></html>`);

  await page.evaluate((markup) => {
    const root = document.createElement('div');
    root.className = 'ant-modal-root';
    root.id = 'promo';
    root.innerHTML = `
      <div class="ant-modal-mask" style="position:fixed;inset:0;background:rgba(0,0,0,.45)"></div>
      <div class="ant-modal-wrap" style="position:fixed;inset:0">
        <div class="ant-modal" role="dialog">
          <div class="ant-carousel">
            <img src="https://example.com/files/imagesliders/promo.png" alt="" />
          </div>
          ${markup}
        </div>
      </div>`;
    root
      .querySelector('.ant-modal-close, .ant-modal-close-x, button')
      ?.addEventListener('click', () => root.remove());
    document.body.appendChild(root);
  }, closeMarkup);
}

const variants: Array<{ label: string; markup: string }> = [
  {
    label: 'icon button labelled "Close" (observed in production)',
    markup: '<button aria-label="Close" class="ant-modal-close">✕</button>',
  },
  {
    label: 'ant-modal-close-x without accessible name',
    markup: '<button class="ant-modal-close-x">✕</button>',
  },
  {
    label: 'Vietnamese text button "Đóng" (legacy markup)',
    markup: '<button class="custom-close">Đóng</button>',
  },
];

async function testClosesEveryKnownVariant() {
  const { closeOneBookingPromotionPopup } = require('../dist/src/automation/1booking/waiters');

  for (const variant of variants) {
    const page = await browser.newPage();
    await mountPromotion(page, variant.markup);

    assert.equal(
      await page.locator('#promo').count(),
      1,
      `${variant.label}: promotion should be mounted`,
    );

    const closed = await closeOneBookingPromotionPopup(page, 2000, 'test');
    assert.equal(closed, true, `${variant.label}: should report closed`);
    assert.equal(
      await page.locator('#promo').count(),
      0,
      `${variant.label}: modal must be removed`,
    );
    assert.equal(
      await page.getByPlaceholder('Chọn điểm đi').isVisible(),
      true,
      `${variant.label}: search form must stay usable`,
    );

    await page.close();
  }
}

async function testIgnoresUnaffectedDialogs() {
  const { closeOneBookingPromotionPopup } = require('../dist/src/automation/1booking/waiters');
  const page = await browser.newPage();

  // A login dialog must never be dismissed as if it were an advertisement.
  await page.setContent(`<!doctype html><html><body>
    <div class="ant-modal-root">
      <div class="ant-modal" role="dialog">
        <input type="password" />
        <button aria-label="Close" class="ant-modal-close">✕</button>
      </div>
    </div>
  </body></html>`);

  const closed = await closeOneBookingPromotionPopup(page, 300, 'test');
  assert.equal(closed, false, 'non-promotion dialogs must be left untouched');
  assert.equal(await page.locator('input[type=password]').count(), 1);

  await page.close();
}

async function main() {
  browser = await chromium.launch({ headless: true });
  try {
    await testClosesEveryKnownVariant();
    await testIgnoresUnaffectedDialogs();
  } finally {
    await browser.close();
  }
  console.log('1Booking promotion popup tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
