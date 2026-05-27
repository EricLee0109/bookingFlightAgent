import { z } from 'zod';
import { readOneBookingAccessToken } from './onebooking-auth-token';
import { type OneBookingPassengerSuggestItem } from './passenger-types';

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const OneBookingPassengerSuggestItemSchema = z.object({
  type: z.number(),
  lastName: z.string(),
  firstName: z.string(),
  title: z.string(),
  gender: z.boolean(),
});

const OneBookingPassengerSuggestResponseSchema = z.array(
  OneBookingPassengerSuggestItemSchema,
);

const ONE_BOOKING_PASSENGER_SUGGEST_ENDPOINT =
  'https://mbkbept.1booking.vn/api/v1/flightpassenger/suggest';

/**
 * Adapter for 1Booking passenger suggestion API.
 *
 * This component owns direct HTTP access only. It does not know about Telegram,
 * Playwright form filling, local resolver confidence, or case status.
 */
export class OneBookingPassengerSuggestAdapter {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly storageStatePath?: string;

  constructor(options: {
    endpoint?: string;
    fetchImpl?: FetchLike;
    storageStatePath?: string;
  } = {}) {
    this.endpoint = options.endpoint ?? ONE_BOOKING_PASSENGER_SUGGEST_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.storageStatePath = options.storageStatePath;
  }

  /**
   * Fetches adult passenger suggestions from 1Booking.
   */
  async suggestPassengers(keyword: string, type = 0) {
    const accessToken = await readOneBookingAccessToken(this.storageStatePath);
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        keyword,
        type,
      }),
    });
    const responseText = await response.text();

    if (!response.ok) {
      if (response.status === 401 || response.status === 498) {
        throw new Error(
          '1Booking passenger suggest auth failed. Run pnpm run save-auth:dev, then retry bootstrap.',
        );
      }

      throw new Error(
        `1Booking passenger suggest failed with HTTP ${response.status}.`,
      );
    }

    let data: unknown;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error('1Booking passenger suggest returned invalid JSON.');
    }

    return OneBookingPassengerSuggestResponseSchema.parse(
      data,
    ) as OneBookingPassengerSuggestItem[];
  }
}
