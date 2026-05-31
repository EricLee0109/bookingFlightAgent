import { type ParsedPassengerMessage } from '../contracts/passenger';

/**
 * Parser contract for turning natural operator text into passenger intent.
 *
 * Implementations extract structured mentions only. Passenger identity is
 * always decided later by the local SQLite resolver.
 */
export type PassengerMessageParser = {
  parse(rawMessage: string): Promise<ParsedPassengerMessage>;
};
