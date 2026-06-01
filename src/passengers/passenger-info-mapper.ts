import {
  type PassengerInfo,
  type PassengerProfile,
} from './passenger-types';

/**
 * Converts a cached passenger profile into the minimal Playwright fill contract.
 *
 * This mapper does not run browser automation. Phase D stores the resulting
 * snapshot so a later fill phase can consume validated passenger data only.
 */
export function mapPassengerProfileToPassengerInfo(
  profile: PassengerProfile,
): PassengerInfo {
  return {
    gender:
      profile.gender === true ? 'M' : profile.gender === false ? 'F' : null,
    lastName: profile.lastName,
    firstName: profile.firstName,
    dob: profile.dateOfBirth,
  };
}
