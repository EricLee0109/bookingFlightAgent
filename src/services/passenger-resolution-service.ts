import { type PassengerMention } from '../contracts/passenger';
import {
  getMissingRequiredPassengerFields,
  PassengerResolver,
  type PassengerResolverOptions,
} from '../passengers/passenger-resolver';
import { PassengerStore } from '../passengers/passenger-store';
import { type PassengerProfile } from '../passengers/passenger-types';

export type ResolvePassengerMentionOptions = PassengerResolverOptions & {
  pendingPassengerProfileId?: number;
};

/**
 * Coordinates local passenger matching and profile enrichment.
 *
 * This service is the boundary between parsed passenger mentions and SQLite.
 * It does not call OpenAI, Telegram, Playwright, or 1Booking automation.
 */
export class PassengerResolutionService {
  private readonly resolver: PassengerResolver;

  constructor(private readonly store: PassengerStore) {
    this.resolver = new PassengerResolver(store);
  }

  /**
   * Resolves a mention, applying newly provided fields to an explicit pending
   * profile when the operator is answering a missing-fields question.
   */
  resolveMention(
    mention: PassengerMention,
    options: ResolvePassengerMentionOptions = {},
  ) {
    const pendingProfile = options.pendingPassengerProfileId
      ? this.store.getPassengerProfileById(options.pendingPassengerProfileId)
      : null;

    if (pendingProfile && hasPassengerDetails(mention)) {
      const enrichedProfile = this.enrichProfile(pendingProfile, mention);

      return this.resolver.resolve(enrichedProfile.normalizedFullName, options);
    }

    const query =
      mention.fullName ?? mention.displayName ?? mention.rawMention ?? '';
    let result = this.resolver.resolve(query, options);

    if (result.status === 'not_found' && mention.fullName) {
      const createdProfile = this.createProfileFromMention(mention);

      if (createdProfile) {
        result = this.resolver.resolve(createdProfile.normalizedFullName, options);
      }
    }

    if (
      (result.status === 'matched' ||
        result.status === 'matched_but_missing_fields') &&
      hasPassengerDetails(mention)
    ) {
      const enrichedProfile = this.enrichProfile(result.profile, mention);

      return this.resolver.resolve(enrichedProfile.normalizedFullName, options);
    }

    return result;
  }

  /**
   * Reads a candidate by local id for Telegram callback confirmation.
   */
  getProfile(profileId: number) {
    return this.store.getPassengerProfileById(profileId);
  }

  /**
   * Returns required fields still missing from a selected local profile.
   */
  getMissingFields(profile: PassengerProfile) {
    return getMissingRequiredPassengerFields(profile);
  }

  private enrichProfile(profile: PassengerProfile, mention: PassengerMention) {
    return this.store.upsertPassengerProfile({
      passengerType: profile.passengerType,
      lastName: profile.lastName,
      firstName: profile.firstName,
      title: profile.title,
      gender: profile.gender,
      dateOfBirth: mention.dob ?? profile.dateOfBirth,
      documentType: mention.idType ?? profile.documentType,
      documentNumber: mention.idNumber ?? profile.documentNumber,
      documentExpiryDate: mention.idExpiry ?? profile.documentExpiryDate,
      documentCountry: profile.documentCountry,
      email: mention.email ?? profile.email,
      source: 'operator_input',
      rawSourceJson: JSON.stringify(mention),
    });
  }

  private createProfileFromMention(mention: PassengerMention) {
    const nameParts = mention.fullName?.trim().split(/\s+/).filter(Boolean) ?? [];

    if (nameParts.length < 2) {
      return null;
    }

    const gender = inferGender(mention);

    return this.store.upsertPassengerProfile({
      passengerType: mapPassengerType(mention.passengerTypeHint),
      lastName: nameParts[0],
      firstName: nameParts.slice(1).join(' '),
      title: gender === true ? 'MR' : gender === false ? 'MS' : 'UNKNOWN',
      gender,
      dateOfBirth: mention.dob,
      documentType: mention.idType,
      documentNumber: mention.idNumber,
      documentExpiryDate: mention.idExpiry,
      email: mention.email,
      source: 'operator_input',
      rawSourceJson: JSON.stringify(mention),
    });
  }
}

function mapPassengerType(passengerType: PassengerMention['passengerTypeHint']) {
  if (passengerType === 'child') return 1;
  if (passengerType === 'infant') return 2;

  return 0;
}

function inferGender(mention: PassengerMention) {
  if (mention.genderHint === 'male') return true;
  if (mention.genderHint === 'female') return false;

  const honorific = mention.honorific?.toLowerCase();

  if (honorific === 'anh' || honorific === 'ong' || honorific === 'chu') {
    return true;
  }

  if (honorific === 'chi' || honorific === 'co' || honorific === 'ba') {
    return false;
  }

  return null;
}

function hasPassengerDetails(mention: PassengerMention) {
  return Boolean(
    mention.dob ||
      mention.idType ||
      mention.idNumber ||
      mention.idExpiry ||
      mention.email,
  );
}
