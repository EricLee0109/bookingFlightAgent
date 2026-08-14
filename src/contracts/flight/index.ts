/**
 * Public exports for the flight request contract layer.
 *
 * Keep Telegram parsing, validation, and automation mapping imports pointed at
 * this boundary so internal file layout can change without touching callers.
 */
export {
  ParsedFlightRequestSchema,
  type FlightResultRanking,
  type ParsedFlightRequest,
  type PreferredTime,
  type TripType,
} from './parsed-flight-request';
export {
  validateAutomationSupport,
  validateSearchFlightInput,
  type AutomationSupportValidation,
  type SearchFlightInputValidation,
} from './search-flight-validation';
export {
  BOOKING_CLASS_LABELS,
  BookingClassSchema,
  SelectMatchingFlightInputSchema,
  type BookingClass,
  type FlightSelectionCandidate,
  type FlightSelectionFailureReason,
  type SelectedFlight,
  type SelectMatchingFlightInput,
} from './flight-selection';
