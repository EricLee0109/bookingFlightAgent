import { test, expect } from '@playwright/test';

test('search agoda flights', async ({ page }) => {
  await page.goto('https://www.agoda.com/flights');

  await page.getByRole('combobox', { name: 'Flying from' }).click();
  await page.getByRole('combobox', { name: 'Flying from' }).fill('han');
  await page.getByRole('option', { name: 'Noi Bai International Airport' }).click();
  await page.getByRole('combobox', { name: 'Flying to' }).click();
  await page.getByRole('combobox', { name: 'Flying to' }).fill('tan');
  await page.getByRole('option', { name: 'Tan Son Nhat International' }).click();
  await page.getByRole('button', { name: 'Sun May 03' }).click();
  await page.getByRole('button', { name: 'SEARCH FLIGHTS' }).click();

  await page.screenshot({ path: "screenshot-flights.png", fullPage: true });
});
