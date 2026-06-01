import { type PassengerMention } from '../contracts/passenger';
import { mapPassengerProfileToPassengerInfo } from '../passengers/passenger-info-mapper';
import {
  getMissingRequiredPassengerFields,
  PassengerResolver,
  type PassengerResolverOptions,
} from '../passengers/passenger-resolver';
import { PassengerStore } from '../passengers/passenger-store';
import {
  type CasePassenger,
  type PassengerInfo,
  type PassengerProfile,
  type PassengerResolveResult,
} from '../passengers/passenger-types';

export type ResolvePassengerMentionOptions = PassengerResolverOptions & {
  caseId?: string;
  pendingPassengerProfileId?: number;
};

export type PassengerMentionResolutionResult =
  | PassengerResolveResult
  | {
      status: 'new_passenger_missing_fields';
      mention: PassengerMention;
      missingFields: string[];
    }
  | {
      status: 'passenger_ready';
      profile: PassengerProfile;
      passengerInfo: PassengerInfo;
      casePassenger: CasePassenger;
      missingFields: [];
    };

/**
 * Coordinates local passenger matching, manual profile upsert, and case attach.
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
   *
   * If no cached profile exists, a new profile is saved only after all fields
   * required by the future 1Booking fill step are present.
   */
  resolveMention(
    mention: PassengerMention,
    options: ResolvePassengerMentionOptions = {},
  ): PassengerMentionResolutionResult {
    const pendingProfile = options.pendingPassengerProfileId
      ? this.store.getPassengerProfileById(options.pendingPassengerProfileId)
      : null;

    if (pendingProfile && hasPassengerDetails(mention)) {
      const enrichedProfile = this.enrichProfile(pendingProfile, mention);

      return this.resolver.resolve(enrichedProfile.normalizedFullName, options);
    }

    const query = mention.fullName ?? '';

    if (
      isCompletePassengerName(mention.fullName) &&
      this.store.findProfilesByNormalizedFullName(mention.fullName).length === 0
    ) {
      return this.upsertNewPassenger(mention, options.caseId);
    }

    let result = this.resolver.resolve(query, options);

    if (result.status === 'not_found') {
      return this.upsertNewPassenger(mention, options.caseId);
    }

    if (
      (result.status === 'matched' ||
        result.status === 'matched_but_missing_fields') &&
      hasPassengerDetails(mention)
    ) {
      const enrichedProfile = this.enrichProfile(result.profile, mention);

      result = this.resolver.resolve(enrichedProfile.normalizedFullName, options);
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

  /**
   * Saves a complete new passenger and optionally attaches it to a case.
   *
   * Missing required fields are returned to Telegram without inserting an
   * incomplete manual profile.
   */
  upsertNewPassenger(
    mention: PassengerMention,
    caseId?: string,
  ): PassengerMentionResolutionResult {
    const missingFields = getMissingNewPassengerFields(mention);

    if (missingFields.length > 0) {
      return {
        status: 'new_passenger_missing_fields',
        mention,
        missingFields,
      };
    }

    const nameParts = mention.fullName?.trim().split(/\s+/).filter(Boolean) ?? [];
    const gender = inferGender(mention);
    const profile = this.store.upsertManualPassenger({
      passengerType: 0,
      lastName: nameParts[0],
      firstName: nameParts.slice(1).join(' '),
      title: mapPassengerTitle(gender),
      gender,
      dateOfBirth: mention.dob,
      source: 'operator_input',
      rawSourceJson: JSON.stringify(mention),
    });
    const passengerInfo = mapPassengerProfileToPassengerInfo(profile);

    if (!caseId) {
      return {
        status: 'matched',
        profile,
        confidenceScore: 1,
        reason: 'full_name_exact',
        missingFields: [],
      };
    }

    const casePassenger = this.attachPassengerToCase(caseId, profile);

    return {
      status: 'passenger_ready',
      profile,
      passengerInfo,
      casePassenger,
      missingFields: [],
    };
  }

  /**
   * Converts and stores a validated passenger snapshot for later Playwright
   * form fill. This method does not run browser automation or click hold.
   */
  attachPassengerToCase(caseId: string, profile: PassengerProfile) {
    const missingFields = getMissingRequiredPassengerFields(profile);

    if (missingFields.length > 0) {
      throw new Error(
        `Cannot attach passenger to case. Missing fields: ${missingFields.join(', ')}`,
      );
    }

    const passengerInfo = mapPassengerProfileToPassengerInfo(profile);

    return this.store.upsertCasePassenger({
      caseId,
      passengerProfileId: profile.id,
      passengerInfo,
      status: 'passenger_ready',
    });
  }

  private enrichProfile(profile: PassengerProfile, mention: PassengerMention) {
    return this.store.upsertPassengerProfile({
      passengerType: profile.passengerType,
      lastName: profile.lastName,
      firstName: profile.firstName,
      title: profile.title,
      gender: inferGender(mention) ?? profile.gender,
      dateOfBirth: mention.dob ?? profile.dateOfBirth,
      source: 'operator_input',
      rawSourceJson: JSON.stringify(mention),
    });
  }
}

/**
 * Returns fields required before inserting a new manual passenger profile.
 */
export function getMissingNewPassengerFields(mention: PassengerMention) {
  const missingFields: string[] = [];

  if (!isCompletePassengerName(mention.fullName)) missingFields.push('fullName');
  if (!mention.gender) missingFields.push('gender');

  return missingFields;
}

function mapPassengerTitle(gender: boolean | null) {
  return gender === true ? 'MR' : gender === false ? 'MS' : 'UNKNOWN';
}

function inferGender(mention: PassengerMention) {
  if (mention.gender === 'male') return true;
  if (mention.gender === 'female') return false;

  return null;
}

function hasPassengerDetails(mention: PassengerMention) {
  return Boolean(mention.gender || mention.dob);
}

/**
 * Requires at least family and given-name tokens before saving a manual profile.
 */
function isCompletePassengerName(fullName: string | null) {
  return (fullName?.trim().split(/\s+/).filter(Boolean).length ?? 0) >= 2;
}
