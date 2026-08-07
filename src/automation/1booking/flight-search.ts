import { type Page } from 'playwright';
import { selectAirport } from './airports';
import { ONE_BOOKING_URL } from './constants';
import { selectDepartureDate } from './dates';
import {
  extractFlightResultCandidates,
  selectFlightResultsForSearch,
  type FlightResultFilterSummary,
} from './flight-result-ranking';
import {
  assertSearchFlightsAutomationInput,
  type SearchFlightsInput,
} from './search-flight-input';
import { submitFlightSearch } from './search-form';
import { takeFlightResultsBatchScreenshots } from './screenshots';
import {
  closeOneBookingImportantNoticeDrawer,
  throwIfOneBookingLoginModalVisible,
  waitForFlightResultsReady,
} from './waiters';

export type SearchFlightsResult = {
  success: boolean;
  flightCount: number;
  displayedFlightCount: number;
  filterSummary?: FlightResultFilterSummary;
  screenshotPath: string;
  screenshotPaths: string[];
};

export type SearchFlightsOptions = {
  screenshotFileNamePrefix?: string;
};

export type { SearchFlightsInput } from './search-flight-input';

/**
 * Runs the MVP one-way 1Booking flight search flow.
 *
 * This component owns browser automation orchestration only:
 * - open 1Booking
 * - select airports
 * - select departure date
 * - run search
 * - wait for results
 * - capture customer-facing result screenshot
 */
export async function searchFlights(
  page: Page,
  input: SearchFlightsInput,
  options: SearchFlightsOptions = {},
): Promise<SearchFlightsResult> {
  assertSearchFlightsAutomationInput(input);

  await page.goto(ONE_BOOKING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await closeOneBookingImportantNoticeDrawer(page);
  await throwIfOneBookingLoginModalVisible(page);

  await selectAirport(page, {
    inputName: 'Chọn điểm đi',
    airportCode: input.fromAirportCode,
    airportText: input.fromAirportText,
  });

  await selectAirport(page, {
    inputName: 'Chọn điểm đến',
    airportCode: input.toAirportCode,
    airportText: input.toAirportText,
  });

  await selectDepartureDate(page, input.departureDate);

  await submitFlightSearch(page);
  await closeOneBookingImportantNoticeDrawer(page, 500);
  await throwIfOneBookingLoginModalVisible(page, 5000);

  const flightCount = await waitForFlightResultsReady(page);
  const candidates = await extractFlightResultCandidates(page);
  const selectedResult = selectFlightResultsForSearch({
    candidates,
    preferredTime: input.preferredTime,
    specificTime: input.specificTime,
    resultRanking: input.resultRanking,
    limit: input.resultLimit,
    preferredAirlineCodes: input.preferredAirlineCodes,
  });

  if (selectedResult && selectedResult.summary.displayedCount === 0) {
    throw new FlightResultBucketEmptyError(selectedResult.summary);
  }

  const displayedCardIndexes =
    selectedResult?.cardIndexes ?? candidates.map((candidate) => candidate.cardIndex);
  const screenshotPaths = await takeFlightResultsBatchScreenshots(
    page,
    options.screenshotFileNamePrefix ?? '1booking-search-flights',
    undefined,
    displayedCardIndexes,
  );
  const [screenshotPath] = screenshotPaths;

  if (!screenshotPath) {
    throw new Error('Expected at least one flight result screenshot.');
  }

  return {
    success: true,
    flightCount,
    displayedFlightCount: selectedResult?.summary.displayedCount ?? candidates.length,
    filterSummary: selectedResult?.summary,
    screenshotPath,
    screenshotPaths,
  };
}

/**
 * Signals that 1Booking returned flights, but none matched the requested
 * time bucket. Telegram can ask the operator for another bucket without
 * widening results silently.
 */
export class FlightResultBucketEmptyError extends Error {
  constructor(readonly summary: FlightResultFilterSummary) {
    super(buildFlightResultEmptyMessage(summary));
    this.name = 'FlightResultBucketEmptyError';
  }
}

function buildFlightResultEmptyMessage(summary: FlightResultFilterSummary) {
  const filters = [
    summary.requestedAirlineNames?.length
      ? `airline ${summary.requestedAirlineNames.join(', ')}`
      : null,
    summary.requestedTimeWindowLabel,
    summary.requestedTimeBucketLabel,
    summary.ranking === 'cheapest' ? 'cheapest ranking' : null,
  ].filter(Boolean);

  return filters.length > 0
    ? `No flight results matched the requested filters: ${filters.join(', ')}.`
    : 'No flight results matched the requested filters.';
}

/**
 * Legacy export kept for older imports while callers migrate to the neutral name.
 */
export class CheapestFlightBucketEmptyError extends FlightResultBucketEmptyError {}
