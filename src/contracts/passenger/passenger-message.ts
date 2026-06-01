import { z } from 'zod';

export const PassengerIntentSchema = z.enum([
  'attach_passenger',
  'provide_new_passenger',
  'update_passenger_fields',
  'confirm_passenger',
  'reject_passenger',
  'unknown',
]);

export const PassengerMentionSchema = z
  .object({
    rawMention: z.string(),
    displayName: z.string().nullable(),
    fullName: z.string().nullable(),
    honorific: z.string().nullable(),
    genderHint: z.enum(['male', 'female']).nullable(),
    passengerTypeHint: z.enum(['adult', 'child', 'infant']).nullable(),
    dob: z.string().nullable(),
    age: z.number().int().nonnegative().nullable(),
    idType: z.enum(['cccd', 'cmnd', 'passport', 'other']).nullable(),
    idNumber: z.string().nullable(),
    idExpiry: z.string().nullable(),
    rawQuickInput: z.string().nullable(),
  })
  .strict();

/**
 * Structured passenger intent extracted from one Telegram operator message.
 *
 * This contract is intentionally descriptive only. AI may extract passenger
 * mentions and fields, but it must never choose a final local DB profile.
 */
export const ParsedPassengerMessageSchema = z
  .object({
    intent: PassengerIntentSchema,
    caseCode: z.string().nullable(),
    passengerMentions: z.array(PassengerMentionSchema),
    missingFields: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type PassengerIntent = z.infer<typeof PassengerIntentSchema>;
export type PassengerMention = z.infer<typeof PassengerMentionSchema>;
export type ParsedPassengerMessage = z.infer<
  typeof ParsedPassengerMessageSchema
>;
