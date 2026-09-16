/**
 * The small passenger record collected from a Telegram customer.
 *
 * This type intentionally contains only the fields that the customer flow
 * needs for one adult passenger. It is kept separate from the 1Booking cache
 * types so customer-owned data cannot be confused with imported profiles.
 */
export type CustomerPassengerInfo = {
  lastName: string;
  firstName: string;
  gender: 'M' | 'F';
  dob: string;
};

export type CustomerPassengerProfile = CustomerPassengerInfo & {
  id: number;
  ownerTelegramUserId: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};
