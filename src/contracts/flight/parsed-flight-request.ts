import { z } from 'zod';

/**
 * Time preference values that the AI parser may extract from a customer message.
 *
 * `specific_time` means the parser found an exact requested time and should also
 * set `specificTime`.
 */
export type PreferredTime =
  | 'early_morning'
  | 'morning'
  | 'afternoon'
  | 'night'
  | 'specific_time'
  | null;

/**
 * Optional ranking intent extracted from a customer/operator request.
 */
export type FlightResultRanking = 'cheapest' | null;

/**
 * Trip type values supported by the shared flight request contract.
 *
 * MVP automation supports one-way search first. Round-trip is included in the
 * contract so Telegram parsing, validation, and storage do not need a breaking
 * schema change later.
 */
export type TripType = 'one_way' | 'round_trip';

/**
 * Structured flight request parsed from a Telegram message.
 *
 * This schema is the safe JSON contract between:
 * - Telegram Agent
 * - AI parser
 * - validation layer
 * - 1Booking automation mapper
 *
 * Notes:
 * - `returnDate` is optional for one-way trips.
 * - `returnDate` is required when `tripType` is `round_trip`.
 * - The MVP may not automate round-trip search yet, but this field is included
 *   now to keep the schema future-proof.
 */
export const ParsedFlightRequestSchema = z
  .object({
    fromAirportCode: z.string().nullable(),
    fromAirportText: z.string().nullable(),

    toAirportCode: z.string().nullable(),
    toAirportText: z.string().nullable(),

    departureDate: z.string().nullable(),
    returnDate: z.string().nullable(),

    preferredTime: z
      .enum([
        'early_morning',
        'morning',
        'afternoon',
        'night',
        'specific_time',
      ])
      .nullable(),

    specificTime: z.string().nullable(),

    resultRanking: z.enum(['cheapest']).nullable(),

    preferredAirlineCodes: z.array(z.string()).nullable(),

    tripType: z.enum(['one_way', 'round_trip']),

    missingFields: z.array(z.string()),
  })
  .superRefine((data, ctx) => {
    if (data.tripType === 'round_trip' && !data.returnDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returnDate'],
        message: 'returnDate is required when tripType is round_trip.',
      });
    }
  });

/**
 * Parsed flight request type inferred from the runtime Zod schema.
 *
 * Keep downstream code using this type instead of a duplicate interface so the
 * static TypeScript contract and runtime validator stay aligned.
 */
export type ParsedFlightRequest = z.infer<typeof ParsedFlightRequestSchema>;
