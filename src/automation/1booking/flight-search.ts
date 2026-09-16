import { type Page } from 'playwright';
import { type FlightResultCandidate } from './flight-result-types';
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
import {
  takeFlightResultsBatchScreenshots,
  takeFlightResultCardScreenshots,
  takeFullPageScreenshot,
} from './screenshots';
import {
  closeOneBookingSearchOverlays,
  throwIfOneBookingLoginModalVisible,
  waitForFlightResultsReady,
} from './waiters';
import {
  createFlightSearchSnapshot,
  type FlightSearchSnapshot,
} from './flight-search-snapshot';

export type SearchFlightsResult = {
  candidates: FlightResultCandidate[];
  success: boolean;
  flightCount: number;
  displayedFlightCount: number;
  filterSummary?: FlightResultFilterSummary;
  screenshotPath: string;
  screenshotPaths: string[];
  /** Present only when the caller opts into the hybrid full-result contract. */
  snapshot?: FlightSearchSnapshot;
};

export type SearchFlightsOptions = {
  screenshotFileNamePrefix?: string;
  /** Retain every observed candidate and permit zero filter matches. */
  fullSnapshot?: boolean;
  /** Explicitly permits a genuine zero-result page after provider settling. */
  allowEmptyResults?: boolean;
  /** Timestamp injection for deterministic snapshot tests. */
  capturedAt?: Date;
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
  await throwIfOneBookingLoginModalVisible(page);
  await closeOneBookingSearchOverlays(page, 2000, options.screenshotFileNamePrefix);

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
  await throwIfOneBookingLoginModalVisible(page, 5000);
  await closeOneBookingSearchOverlays(page, 500, options.screenshotFileNamePrefix);

  const allowEmptyResults = options.fullSnapshot || options.allowEmptyResults;
  const flightCount = await waitForFlightResultsReady(page, {
    allowEmpty: allowEmptyResults,
  });
  const parsedCandidates = await extractFlightResultCandidates(page);
  // A zero-count result is authoritative after provider settling.  Do not
  // accidentally carry stale cards from a previous search into its snapshot.
  const candidates = flightCount === 0 ? [] : parsedCandidates;
  assertParsedFlightCandidatesMatchFlightCount(flightCount, candidates, {
    requireExactCount: options.fullSnapshot,
  });
  const selectedResult = selectFlightResultsForSearch({
    candidates,
    preferredTime: input.preferredTime,
    specificTime: input.specificTime,
    resultRanking: input.resultRanking,
    limit: input.resultLimit,
    preferredAirlineCodes: input.preferredAirlineCodes,
    timeConstraint: input.timeConstraint,
  });

  if (!options.fullSnapshot && selectedResult && selectedResult.summary.displayedCount === 0) {
    throw new FlightResultBucketEmptyError(selectedResult.summary);
  }

  const displayedCardIndexes =
    options.fullSnapshot
      ? candidates.map((candidate) => candidate.cardIndex)
      : selectedResult?.cardIndexes ?? candidates.map((candidate) => candidate.cardIndex);
  const screenshotPrefix = options.screenshotFileNamePrefix ?? '1booking-search-flights';
  const screenshotPaths = flightCount === 0 && allowEmptyResults
    ? [await takeFullPageScreenshot(page, `${screenshotPrefix}-empty-${Date.now()}.png`)]
    : options.fullSnapshot
      ? await takeFlightResultCardScreenshots(page, screenshotPrefix, candidates)
      : await takeFlightResultsBatchScreenshots(
        page,
        screenshotPrefix,
        undefined,
        displayedCardIndexes,
      );
  const [screenshotPath] = screenshotPaths;

  if (!screenshotPath) {
    throw new Error('Expected at least one flight result screenshot.');
  }

  const snapshot = options.fullSnapshot
    ? createFlightSearchSnapshot({
        capturedAt: options.capturedAt,
        route: {
          fromAirportCode: input.fromAirportCode,
          fromAirportText: input.fromAirportText,
          toAirportCode: input.toAirportCode,
          toAirportText: input.toAirportText,
        },
        departureDate: input.departureDate,
        candidates,
        screenshotPaths,
        screenshotBatchSize: 1,
        observedFlightCount: flightCount,
      })
    : undefined;

  return {
    success: true,
    candidates: options.fullSnapshot ? snapshot!.candidates : selectedResult?.candidates ?? candidates,
    flightCount,
    displayedFlightCount: selectedResult?.summary.displayedCount ?? candidates.length,
    filterSummary: selectedResult?.summary,
    screenshotPath,
    screenshotPaths,
    snapshot,
  };
}

/** Fails closed when the UI reports cards but the parser cannot verify any. */
export function assertParsedFlightCandidatesMatchFlightCount(
  flightCount: number,
  candidates: FlightResultCandidate[],
  options: { requireExactCount?: boolean } = {},
) {
  const incomplete = options.requireExactCount
    ? flightCount !== candidates.length
    : flightCount > 0 && candidates.length === 0;
  if (incomplete) {
    throw new Error(
      options.requireExactCount
        ? `1Booking reported ${flightCount} flight result(s), but only ${candidates.length} cards could be parsed. Search snapshot was not persisted.`
        : `1Booking reported ${flightCount} flight result(s), but no cards could be parsed. Search snapshot was not persisted.`,
    );
  }
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
