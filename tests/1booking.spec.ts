import test, { expect } from "@playwright/test";
import { chromium } from "@playwright/test";

test('search 1booking flights', async ({ page }) => {
    await page.goto('https://pro.1booking.vn/');

    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.getByRole('textbox', { name: '* Mã đại lý' }).click();
    await page.getByRole('textbox', { name: '* Mã đại lý' }).fill('HS2200389');
    await page.getByRole('textbox', { name: '* Tên đăng nhập' }).click();
    await page.getByRole('textbox', { name: '* Tên đăng nhập' }).fill('LETHAIKHOA');
    await page.getByRole('textbox', { name: '* Mật khẩu' }).click();
    await page.getByRole('textbox', { name: '* Mật khẩu' }).fill('Kimngan$2026');
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.locator('div').filter({ hasText: /^LƯU Ý QUAN TRỌNG$/ }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('textbox', { name: 'Chọn điểm đi' }).click();
    await page.getByRole('textbox', { name: 'Chọn điểm đi' }).fill('HAN');
    await page.locator('div').filter({ hasText: /^Sân bay Nội Bài \(HAN\)Hà Nội, Việt Nam$/ }).first().click();
    await page.getByRole('textbox', { name: 'Chọn điểm đến' }).click();
    await page.getByRole('textbox', { name: 'Chọn điểm đến' }).fill('SGN');
    await page.locator('.cursor-pointer.rounded-lg').click();
    await page.getByRole('button', { name: 'search-ic Tìm kiếm' }).click();
    await expect(page.locator('div').filter({ hasText: /^tìm thấy 15 kết quả$/ }).nth(2)).toBeVisible();

    await page.screenshot({ path: "flights-screenshots/screenshot-1booking.png", fullPage: true });

});
