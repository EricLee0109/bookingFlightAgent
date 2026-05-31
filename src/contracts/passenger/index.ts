/**
 * Public exports for passenger intent contracts.
 *
 * Agent parsers, services, and Telegram presentation import from this boundary
 * so schema ownership remains separate from transport and persistence.
 */
export {
  ParsedPassengerMessageSchema,
  PassengerIntentSchema,
  PassengerMentionSchema,
  type ParsedPassengerMessage,
  type PassengerIntent,
  type PassengerMention,
} from './passenger-message';
