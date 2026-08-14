import { type Locator, type Page } from 'playwright';
import {
  type FlightSelectionCandidate,
  type FlightSelectionFailureReason,
  type SelectMatchingFlightInput,
} from '../../contracts/flight';
import {
  extractFlightResultCandidates,
  getFlightCards,
} from './flight-result-ranking';
import { type SearchFlightsInput, searchFlights } from './flight-search';
import { takeCaseUiScreenshot } from './screenshots';
import { throwIfOneBookingLoginModalVisible } from './waiters';

export type FlightSelectionMatchResult =
  | {
      ok: true;
      candidate: FlightSelectionCandidate;
    }
  | {
      ok: false;
      reason: 'no_match' | 'multiple_matches';
      candidates: FlightSelectionCandidate[];
      message: string;
    };

type FlightSelectionMatchFailure = Extract<
  FlightSelectionMatchResult,
  { ok: false }
>;

/**
 * Preserves a deterministic flight-match failure across service boundaries.
 */
export class FlightSelectionMatchError extends Error {
  readonly reason: Extract<
    FlightSelectionFailureReason,
    'no_match' | 'multiple_matches'
  >;
  readonly candidates: FlightSelectionCandidate[];

  constructor(result: FlightSelectionMatchFailure) {
    super(result.message);
    this.name = 'FlightSelectionMatchError';
    this.reason = result.reason;
    this.candidates = result.candidates;
  }
}

export type SelectMatchingFlightResult = {
  selectedFlight: FlightSelectionCandidate;
  screenshotPath: string;
};

/**
 * Refreshes 1Booking search results and selects one matching flight card.
 *
 * This component owns the browser flow for selection only. It does not parse
 * Telegram text and it does not fill passenger information.
 */
export async function selectMatchingFlight(
  page: Page,
  searchInput: SearchFlightsInput,
  selectionInput: SelectMatchingFlightInput,
): Promise<SelectMatchingFlightResult> {
  const selectedFlight = await openMatchingFlightPassengerForm(
    page,
    searchInput,
    selectionInput,
  );

  const screenshotPath = await takeCaseUiScreenshot(
    page,
    selectionInput.caseId,
    'selected-flight',
  );

  return {
    selectedFlight,
    screenshotPath,
  };
}

/**
 * Refreshes live results, selects one exact flight, and opens passenger form.
 *
 * Hold-booking automation reuses this helper to avoid trusting stale browser
 * state from the earlier Telegram selection step.
 */
export async function openMatchingFlightPassengerForm(
  page: Page,
  searchInput: SearchFlightsInput,
  selectionInput: SelectMatchingFlightInput,
) {
  await searchFlights(page, searchInput);

  const candidates = await extractFlightSelectionCandidates(page);
  const matchResult = matchFlightSelectionCandidate(candidates, selectionInput);

  if (!matchResult.ok) {
    throw new FlightSelectionMatchError(matchResult);
  }

  const flightCards = getFlightCards(page);
  const matchedCard = flightCards.nth(matchResult.candidate.cardIndex);

  await clickChooseNow(page, matchedCard);
  await verifySelectedFlightPanel(page, matchResult.candidate);
  await clickHoldBooking(page);
  await waitForPassengerInformationPage(page);

  return matchResult.candidate;
}

/**
 * Reads visible flight cards into structured candidates for safe matching.
 *
 * Flight number and booking class are extracted from the current 1Booking UI,
 * not from Telegram or AI output.
 */
export async function extractFlightSelectionCandidates(page: Page) {
  return extractFlightResultCandidates(page);
}

/**
 * Matches the requested departure time and booking class, plus airline when
 * the operator explicitly provided one.
 *
 * The function refuses to choose when the refreshed result list has no exact
 * candidate or more than one candidate.
 */
export function matchFlightSelectionCandidate(
  candidates: FlightSelectionCandidate[],
  input: SelectMatchingFlightInput,
): FlightSelectionMatchResult {
  const matches = candidates.filter(
    (candidate) =>
      (!input.airlineCode || candidate.airlineCode === input.airlineCode) &&
      candidate.departureTime === input.departureTime &&
      (!input.bookingClass ||
        (candidate.bookingClass !== null &&
          candidate.bookingClass === input.bookingClass)),
  );

  if (matches.length === 1) {
    return {
      ok: true,
      candidate: matches[0],
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'multiple_matches',
      candidates: matches,
      message: [
        `Found ${matches.length} matching flights. Please add more detail before selecting.`,
        formatCandidateSummary(matches),
      ].join('\n'),
    };
  }

  return {
    ok: false,
    reason: 'no_match',
    candidates: [],
    message: `No available flight matched ${[
      input.airlineCode,
      input.departureTime,
      input.bookingClass,
    ]
      .filter(Boolean)
      .join(' ')}.`,
  };
}

/**
 * Formats ambiguous candidates so Telegram can ask the operator for detail.
 */
function formatCandidateSummary(candidates: FlightSelectionCandidate[]) {
  return candidates
    .map((candidate) =>
      [
        candidate.flightNumber,
        candidate.departureTime,
        candidate.arrivalTime ? `-${candidate.arrivalTime}` : '',
        candidate.bookingClass ?? candidate.rawBookingClassCode ?? 'no fare code',
        candidate.priceText ? `, ${candidate.priceText}` : '',
      ].join(''),
    )
    .join('\n');
}

/**
 * Locates the visible 1Booking flight-card collection.
 */
/**
 * Clicks the `Chọn ngay` button inside one matched flight card.
 */
async function clickChooseNow(page: Page, flightCard: Locator) {
  const chooseButton = flightCard
    .getByRole('button', {
      name: /Chọn ngay|Chon ngay/i,
    })
    .first();

  await chooseButton.waitFor({
    state: 'visible',
    timeout: 10000,
  });

  await chooseButton.click();
  await throwIfOneBookingLoginModalVisible(page, 3000);
}

/**
 * Confirms the right-side selected-flight panel reflects the matched card.
 */
async function verifySelectedFlightPanel(
  page: Page,
  candidate: FlightSelectionCandidate,
) {
  const selectedPanel = page
    .locator('div')
    .filter({
      hasText: /Chuyến đang chọn|Chuyen dang chon/i,
    })
    .filter({
      hasText: new RegExp(candidate.flightNumber, 'i'),
    })
    .last();

  await selectedPanel.waitFor({
    state: 'visible',
    timeout: 15000,
  });
}

/**
 * Clicks `Giữ chỗ` after the selected-flight panel is populated.
 */
async function clickHoldBooking(page: Page) {
  await throwIfOneBookingLoginModalVisible(page, 1000);

  const holdButton = page
    .getByRole('button', {
      name: /Giữ chỗ|Giu cho/i,
    })
    .first();

  await holdButton.waitFor({
    state: 'visible',
    timeout: 15000,
  });

  await holdButton.click();
  await throwIfOneBookingLoginModalVisible(page, 5000);
}

/**
 * Waits until 1Booking navigates to the passenger information page.
 */
async function waitForPassengerInformationPage(page: Page) {
  await page
    .getByText(/Thông tin khách hàng|Thong tin khach hang/i)
    .first()
    .waitFor({
      state: 'visible',
      timeout: 30000,
    });
}

/**
 * Parses one flight card's visible text into a selection candidate.
 */
