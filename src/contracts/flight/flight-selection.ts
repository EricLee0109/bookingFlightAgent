import { z } from 'zod';
import { BOOKING_CASE_REGEX } from '../../automation/1booking/constants';

export const BookingClassSchema = z.enum(['ECO', 'DLX', 'SGB', 'SBB']);

export type BookingClass = z.infer<typeof BookingClassSchema>;

export const BOOKING_CLASS_LABELS: Record<BookingClass, string> = {
  ECO: 'Eco',
  DLX: 'Deluxe',
  SGB: 'SkyBoss',
  SBB: 'SkyBoss Business',
};

export const SelectMatchingFlightInputSchema = z.object({
  caseId: z.string().regex(BOOKING_CASE_REGEX),
  airlineCode: z.string().min(2).nullable(),
  airlineName: z.string().min(1).nullable(),
  departureTime: z.string().regex(/^\d{2}:\d{2}$/),
  bookingClass: BookingClassSchema.default('ECO'),
});

export type SelectMatchingFlightInput = z.infer<
  typeof SelectMatchingFlightInputSchema
>;

export type FlightSelectionCandidate = {
  cardIndex: number;
  airlineCode: string;
  airlineName: string;
  flightNumber: string;
  departureTime: string;
  arrivalTime: string | null;
  bookingClass: BookingClass;
  priceText: string | null;
};

/**
 * Structured result saved after automation selects a real 1Booking flight card.
 *
 * The flight number is intentionally captured from the refreshed UI, not from
 * Telegram or AI parser text.
 */
export type SelectedFlight = FlightSelectionCandidate & {
  selectedAt: string;
};
