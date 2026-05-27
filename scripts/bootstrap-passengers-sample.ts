import 'dotenv/config';
import { OneBookingPassengerSuggestAdapter } from '../src/passengers/onebooking-passenger-suggest-adapter';
import { PassengerBootstrapWorker } from '../src/passengers/passenger-bootstrap-worker';
import { buildPassengerBootstrapSampleSeeds } from '../src/passengers/passenger-bootstrap-seeds';
import { PassengerStore } from '../src/passengers/passenger-store';

/**
 * Runs a small passenger bootstrap for validating auth, API shape, and DB writes.
 */
async function main() {
  const store = new PassengerStore();
  const worker = new PassengerBootstrapWorker(
    new OneBookingPassengerSuggestAdapter(),
    store,
  );

  try {
    const stats = await worker.bootstrap(buildPassengerBootstrapSampleSeeds(20));

    console.log('Passenger sample bootstrap completed.');
    console.log(JSON.stringify({ ...stats, db: store.getStats() }, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error('Passenger sample bootstrap failed:', error);
  process.exit(1);
});
