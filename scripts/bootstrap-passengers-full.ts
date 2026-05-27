import 'dotenv/config';
import { OneBookingPassengerSuggestAdapter } from '../src/passengers/onebooking-passenger-suggest-adapter';
import { PassengerBootstrapWorker } from '../src/passengers/passenger-bootstrap-worker';
import { buildPassengerBootstrapSeeds } from '../src/passengers/passenger-bootstrap-seeds';
import { PassengerStore } from '../src/passengers/passenger-store';

/**
 * Runs the full passenger bootstrap seed set.
 */
async function main() {
  const store = new PassengerStore();
  const incrementalKeywords = store.listIncrementalSeedKeywords(100);
  const worker = new PassengerBootstrapWorker(
    new OneBookingPassengerSuggestAdapter(),
    store,
  );

  try {
    const stats = await worker.bootstrap(
      buildPassengerBootstrapSeeds({
        incrementalKeywords,
      }),
    );

    console.log('Passenger full bootstrap completed.');
    console.log(JSON.stringify({ ...stats, db: store.getStats() }, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error('Passenger full bootstrap failed:', error);
  process.exit(1);
});
