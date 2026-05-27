import { OneBookingPassengerSuggestAdapter } from './onebooking-passenger-suggest-adapter';
import { type PassengerStore } from './passenger-store';

export type PassengerBootstrapStats = {
  keywordCount: number;
  responsePassengerCount: number;
  upsertedPassengerCount: number;
  failedKeywordCount: number;
  failures: Array<{
    keyword: string;
    message: string;
  }>;
};

/**
 * Bootstraps the local passenger DB from 1Booking passenger suggestions.
 *
 * This worker owns batch orchestration only: it calls the adapter, upserts
 * profiles into SQLite, and applies a small delay between API calls.
 */
export class PassengerBootstrapWorker {
  constructor(
    private readonly adapter: OneBookingPassengerSuggestAdapter,
    private readonly store: PassengerStore,
    private readonly options: {
      delayMs?: number;
      passengerType?: number;
    } = {},
  ) {}

  /**
   * Runs bootstrap for the provided keywords.
   */
  async bootstrap(keywords: string[]): Promise<PassengerBootstrapStats> {
    this.store.migrate();

    const stats: PassengerBootstrapStats = {
      keywordCount: keywords.length,
      responsePassengerCount: 0,
      upsertedPassengerCount: 0,
      failedKeywordCount: 0,
      failures: [],
    };

    for (const keyword of keywords) {
      try {
        const passengers = await this.adapter.suggestPassengers(
          keyword,
          this.options.passengerType ?? 0,
        );

        stats.responsePassengerCount += passengers.length;

        for (const passenger of passengers) {
          this.store.upsertOneBookingSuggestPassenger(passenger);
          stats.upsertedPassengerCount += 1;
        }
      } catch (error) {
        stats.failedKeywordCount += 1;
        stats.failures.push({
          keyword,
          message: error instanceof Error ? error.message : 'Unknown error.',
        });
      }

      await delay(this.options.delayMs ?? 250);
    }

    return stats;
  }
}

function delay(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
