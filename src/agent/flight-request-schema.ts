/**
 * Compatibility export for agent parser code.
 *
 * The canonical schema and type live in `src/contracts/flight` so runtime Zod
 * validation and TypeScript parser contracts stay aligned.
 */
export {
  ParsedFlightRequestSchema,
  type ParsedFlightRequest,
  type PreferredTime,
  type TripType,
} from '../contracts/flight';
