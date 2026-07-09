import { type Page } from 'playwright';
import { parseFlightCardText } from './flight-card-parser';
import { type FlightResultCandidate } from './flight-result-types';

/**
 * Reads visible 1Booking flight result cards into structured candidates.
 *
 * This component is shared by search-result ranking and selection matching so
 * both flows interpret live 1Booking cards in the same way.
 */
export async function extractFlightResultCandidates(page: Page) {
  const flightCards = getFlightCards(page);
  const count = await flightCards.count();
  const candidates: FlightResultCandidate[] = [];

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
 * Returns the visible 1Booking flight-card collection.
 */
export function getFlightCards(page: Page) {
  return page
    .getByRole('list', {
      name: /Single ticket options/i,
    })
    .locator(':scope > div');
}
