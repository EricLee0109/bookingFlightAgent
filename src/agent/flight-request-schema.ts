export type TripType = 'one_way' | 'round_trip';

export type PreferredTime =
  | 'morning'
  | 'afternoon'
  | 'evening'
  | 'night'
  | 'specific_time'
  | null;

/**
 * Structured flight request parsed from a Telegram message.
 *
 * This type is the contract between:
 * - Telegram Agent
 * - AI parser / mock parser
 * - validation layer
 * - 1Booking automation mapper
 *
 * Notes:
 * - `returnDate` is optional for one-way trips.
 * - `returnDate` is required later when `tripType` is `round_trip`.
 * - MVP now uses `departureDate` in Playwright, so the mapper validates it
 *   before automation starts.
 */
export type ParsedFlightRequest = {
  fromAirportCode: string;
  fromAirportText: string;

  toAirportCode: string;
  toAirportText: string;

  departureDate: string;
  returnDate: string | null;

  preferredTime: PreferredTime;
  specificTime: string | null;

  tripType: TripType;

  missingFields: string[];
};
