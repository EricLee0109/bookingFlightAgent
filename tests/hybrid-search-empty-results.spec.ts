import { expect, test } from '@playwright/test';
import { extractFlightResultCandidates } from '../src/automation/1booking/flight-result-candidates';
import {
  assertParsedFlightCandidatesMatchFlightCount,
} from '../src/automation/1booking/flight-search';
import { waitForFlightResultsReady } from '../src/automation/1booking/waiters';

test.setTimeout(30_000);

test('accepts an opted-in genuine zero-result page after provider settling', async ({ page }) => {
  await page.setContent('<div>Tìm thấy 0 kết quả</div>');

  await expect(waitForFlightResultsReady(page, { allowEmpty: true })).resolves.toBe(0);
});

test('does not accept a transient zero before provider cards finish rendering', async ({ page }) => {
  await page.setContent(`
    <div id="summary">Tìm thấy 0 kết quả</div>
    <div id="loading">Đang tìm hệ thống</div>
    <script>
      setTimeout(() => {
        document.getElementById('loading').remove();
        document.getElementById('summary').textContent = 'Tìm thấy 1 kết quả';
        const list = document.createElement('div');
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', 'Single ticket options');
        const option = document.createElement('div');
        option.textContent = 'flight result';
        list.append(option);
        document.body.append(list);
      }, 100);
    </script>
  `);

  await expect(waitForFlightResultsReady(page, { allowEmpty: true })).resolves.toBe(1);
});

test('re-reads a positive count when provider appends cards after the first count', async ({ page }) => {
  await page.setContent(`
    <div id="summary">Tìm thấy 1 kết quả</div>
    <div id="loading">Đang tìm hệ thống</div>
    <div role="list" aria-label="Single ticket options"><div>first result</div></div>
    <script>
      setTimeout(() => {
        document.getElementById('loading').remove();
        document.getElementById('summary').textContent = 'Tìm thấy 2 kết quả';
        const list = document.querySelector('[role="list"]');
        const option = document.createElement('div');
        option.textContent = 'second result';
        list.append(option);
      }, 1000);
    </script>
  `);

  await expect(waitForFlightResultsReady(page, { allowEmpty: true })).resolves.toBe(2);
});

test('fails closed when the UI reports flights but no candidate card parses', async ({ page }) => {
  await page.setContent(`
    <div role="list" aria-label="Single ticket options">
      <div>an unsupported card without airline, flight number or times</div>
    </div>
  `);

  const candidates = await extractFlightResultCandidates(page);
  expect(candidates).toHaveLength(0);
  expect(() => assertParsedFlightCandidatesMatchFlightCount(1, candidates)).toThrow(
    'no cards could be parsed',
  );
  expect(() => assertParsedFlightCandidatesMatchFlightCount(2, [
    {
      cardIndex: 0,
      airlineCode: 'VN',
      airlineName: 'Vietnam Airlines',
      flightNumber: 'VN100',
      departureTime: '08:00',
      arrivalTime: '10:00',
      bookingClass: 'ECO',
      rawBookingClassCode: 'ECO',
      priceText: '1,000,000 VND',
      priceAmount: 1_000_000,
    },
  ], { requireExactCount: true })).toThrow('only 1 cards could be parsed');
});
