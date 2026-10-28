import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { extractFlightResultCandidates } from '../src/automation/1booking/flight-result-candidates';
import { takeFlightResultCardScreenshots } from '../src/automation/1booking/screenshots';
import { createFlightSearchSnapshot, filterFlightSearchSnapshot, screenshotsForFlightSearchResult } from '../src/automation/1booking/flight-search-snapshot';
import { createEmptyHybridSearchSession, HybridSearchSessionStore } from '../src/storage/hybrid-search-session-store';

test('eight observed cards become exactly two evening images, with persisted ID mapping', async ({ page }, testInfo) => {
  // HTML is a local fixture; no 1Booking, model, Telegram or provider request.
  const times = ['08:10', '06:10', '09:40', '19:10', '16:00', '19:50', '07:00', '16:00'];
  await page.setContent(`<style>body{margin:0} [role=list]{width:420px} .card{box-sizing:border-box;width:400px;height:80px;margin:10px;background:#e6f0ff;border:2px solid #235ea5;font:18px sans-serif}</style>
    <div role="list" aria-label="Single ticket options">${times.map((time, i) => `<div class="card">${i === 5 ? 'Vietjet Air VJ' : 'Vietnam Airlines VN'}${100 + i}<br>SGN → CXR ${time}<br>VND ${1000000 + i}</div>`).join('')}</div>`);
  const originalViewport = page.viewportSize();
  const candidates = await extractFlightResultCandidates(page);
  expect(candidates).toHaveLength(8);
  const paths = await takeFlightResultCardScreenshots(page, 'fixture', candidates, testInfo.outputPath('cards'));
  expect(paths).toHaveLength(8);
  expect(page.viewportSize()).toEqual(originalViewport);
  for (const path of paths) {
    const png = await fs.readFile(path);
    expect(png.readUInt32BE(16)).toBe(400);
    expect(png.readUInt32BE(20)).toBe(80);
  }
  const snapshot = createFlightSearchSnapshot({
    snapshotId: 'FS-screen-fixture', capturedAt: '2026-09-16T04:46:00Z',
    route: { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'CXR', toAirportText: 'Cam Ranh' },
    departureDate: '2026-12-12', observedFlightCount: 8,
    candidates,
    screenshotPaths: paths, screenshotBatchSize: 1,
  });
  const store = new HybridSearchSessionStore(testInfo.outputPath('sessions'));
  const state = createEmptyHybridSearchSession(42);
  Object.assign(state, { snapshot, snapshotId: snapshot.snapshotId, snapshotFresh: true, draftRequest: { ...snapshot.route, departureDate: snapshot.departureDate } });
  await store.write(42, state);
  const restored = (await store.read(42))!.snapshot!;
  const evening = filterFlightSearchSnapshot(restored, { preferredTime: 'night' }, { todayIso: '2026-09-16' });
  expect(evening.selectedCandidates.map(c => c.departureTime)).toEqual(['19:10', '19:50']);
  const images = screenshotsForFlightSearchResult(restored, evening.selectedCandidates.map(c => c.candidateId));
  expect(images.map(batch => batch.path)).toEqual([paths[3], paths[5]]);
  expect(images.flatMap(batch => batch.candidateIds)).toEqual(['candidate-3', 'candidate-5']);
  // Reordering and a subsequent airline change must use the same original pixels.
  expect(screenshotsForFlightSearchResult(restored, ['candidate-5', 'candidate-3']).map(b => b.path)).toEqual([paths[5], paths[3]]);
  const vietjet = filterFlightSearchSnapshot(restored, { preferredTime: 'night', preferredAirlineCodes: ['VJ'] }, { todayIso: '2026-09-16' });
  expect(screenshotsForFlightSearchResult(restored, vietjet.selectedCandidates.map(c => c.candidateId)).map(b => b.path)).toEqual([paths[5]]);
  expect(restored.screenshots).toHaveLength(8);
  await testInfo.attach('evening-1910', { path: paths[3], contentType: 'image/png' });
  await testInfo.attach('evening-1950', { path: paths[5], contentType: 'image/png' });
});

test('a missing or hidden candidate fails instead of returning the next visible card', async ({ page }, testInfo) => {
  await page.setContent('<div role="list" aria-label="Single ticket options"><div style="display:none">hidden</div><div>visible</div></div>');
  await expect(takeFlightResultCardScreenshots(page, 'missing', [{ cardIndex: 0 } as never], testInfo.outputPath('cards'))).rejects.toThrow(/no longer visible/);
  await expect(takeFlightResultCardScreenshots(page, 'duplicate', [{ cardIndex: 1 } as never, { cardIndex: 1 } as never], testInfo.outputPath('cards'))).rejects.toThrow(/unique/);
});

test('changed flight identity or price is never attached to the old candidate', async ({ page }, testInfo) => {
  await page.setContent('<div role="list" aria-label="Single ticket options"><div>Vietnam Airlines VN123 19:10 VND 1000000</div></div>');
  const candidates = await extractFlightResultCandidates(page);
  expect(candidates).toHaveLength(1);
  await page.locator('[role=list] > div').evaluate(el => { el.textContent = 'Vietnam Airlines VN999 06:10 VND 1000000'; });
  await expect(takeFlightResultCardScreenshots(page, 'changed', candidates, testInfo.outputPath('cards'))).rejects.toThrow(/Flight card changed/);
  await page.locator('[role=list] > div').evaluate(el => { el.textContent = 'Vietnam Airlines VN123 19:10 VND 2000000'; });
  await expect(takeFlightResultCardScreenshots(page, 'changed-price', candidates, testInfo.outputPath('cards'))).rejects.toThrow(/Flight card changed/);
});
