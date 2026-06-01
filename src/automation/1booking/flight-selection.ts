import { type Locator, type Page } from 'playwright';
import { resolveAirlineFromText } from '../../agent/airline-catalog';
import {
  type BookingClass,
  type FlightSelectionCandidate,
  type SelectMatchingFlightInput,
} from '../../contracts/flight';
import { type SearchFlightsInput, searchFlights } from './flight-search';
import { takeFullPageScreenshot } from './screenshots';
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
  await searchFlights(page, searchInput);

  const candidates = await extractFlightSelectionCandidates(page);
  const matchResult = matchFlightSelectionCandidate(candidates, selectionInput);

  if (!matchResult.ok) {
    throw new Error(matchResult.message);
  }

  const flightCards = getFlightCards(page);
  const matchedCard = flightCards.nth(matchResult.candidate.cardIndex);

  await clickChooseNow(page, matchedCard);
  await verifySelectedFlightPanel(page, matchResult.candidate);
  await clickHoldBooking(page);
  await waitForPassengerInformationPage(page);

  const screenshotPath = await takeFullPageScreenshot(
    page,
    `${selectionInput.caseId}-selected-flight.png`,
  );

  return {
    selectedFlight: matchResult.candidate,
    screenshotPath,
  };
}

/**
 * Reads visible flight cards into structured candidates for safe matching.
 *
 * Flight number and booking class are extracted from the current 1Booking UI,
 * not from Telegram or AI output.
 */
export async function extractFlightSelectionCandidates(page: Page) {
  const flightCards = getFlightCards(page);
  const count = await flightCards.count();
  const candidates: FlightSelectionCandidate[] = [];

  for (let cardIndex = 0; cardIndex < count; cardIndex++) {
    const card = flightCards.nth(cardIndex);

    if (!(await card.isVisible())) {
      continue;
    }

    const candidate = parseFlightCardText(cardIndex, await card.innerText());

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
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
      candidate.bookingClass === input.bookingClass,
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
        candidate.bookingClass,
        candidate.priceText ? `, ${candidate.priceText}` : '',
      ].join(''),
    )
    .join('\n');
}

/**
 * Locates the visible 1Booking flight-card collection.
 */
function getFlightCards(page: Page) {
  return page
    .getByRole('list', {
      name: /Single ticket options/i,
    })
    .locator(':scope > div');
}

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
function parseFlightCardText(
  cardIndex: number,
  cardText: string,
): FlightSelectionCandidate | null {
  const airline = resolveAirlineFromText(cardText);
  const flightNumber = extractFlightNumber(cardText);
  const bookingClass = extractBookingClassFromCard(cardText);
  const times = extractTimes(cardText);

  if (!airline || !flightNumber || !bookingClass || times.length === 0) {
    return null;
  }

  return {
    cardIndex,
    airlineCode: airline.code,
    airlineName: airline.name,
    flightNumber,
    departureTime: times[0],
    arrivalTime: times[1] ?? null,
    bookingClass,
    priceText: extractPriceText(cardText),
  };
}

/**
 * Extracts the visible 1Booking flight number from card text.
 */
function extractFlightNumber(cardText: string) {
  return (
    cardText.match(/\b(?:VJ|VN|QH|VU|9S)\d+[A-Z]?\b/i)?.[0]?.toUpperCase() ??
    null
  );
}

/**
 * Extracts the visible booking class code from card text.
 */
function extractBookingClassFromCard(cardText: string): BookingClass | null {
  const classMatch = cardText.match(/\b(?:[A-Z0-9]+_)?(ECO|DLX|SGB|SBB)\b/i);

  return (classMatch?.[1]?.toUpperCase() as BookingClass | undefined) ?? null;
}

/**
 * Extracts departure/arrival time candidates from card text.
 */
function extractTimes(cardText: string) {
  return Array.from(cardText.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)).map(
    (match) => match[0],
  );
}

/**
 * Extracts the first visible VND price from card text for operator review.
 */
function extractPriceText(cardText: string) {
  return cardText.match(/VND\s*[\d,.]+/i)?.[0] ?? null;
}
