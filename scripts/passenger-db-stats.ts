import 'dotenv/config';
import { PassengerStore } from '../src/passengers/passenger-store';

/**
 * Prints local passenger cache statistics for manual verification.
 */
function main() {
  const store = new PassengerStore();

  try {
    console.log(JSON.stringify(store.getStats(), null, 2));
  } finally {
    store.close();
  }
}

main();
