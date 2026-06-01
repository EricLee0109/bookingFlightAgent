import {
  type PassengerInfo,
  type PassengerProfile,
} from './passenger-types';

/**
 * Converts a cached passenger profile into the stable Playwright fill contract.
 *
 * This mapper does not run browser automation. Phase D stores the resulting
 * snapshot so a later fill phase can consume validated passenger data only.
 */
export function mapPassengerProfileToPassengerInfo(
  profile: PassengerProfile,
): PassengerInfo {
  return {
    title: mapPassengerTitle(profile.title),
    lastName: profile.lastName,
    firstName: profile.firstName,
    dob: profile.dateOfBirth,
    gender:
      profile.gender === true ? 'M' : profile.gender === false ? 'F' : null,
    idType: mapDocumentType(profile.documentType),
    idNumber: profile.documentNumber,
    idExpiry: profile.documentExpiryDate,
  };
}

function mapPassengerTitle(title: string): PassengerInfo['title'] {
  if (
    title === 'MR' ||
    title === 'MS' ||
    title === 'MRS' ||
    title === 'MSTR' ||
    title === 'MISS'
  ) {
    return title;
  }

  return null;
}

function mapDocumentType(
  documentType: string | null,
): PassengerInfo['idType'] {
  if (
    documentType === 'cccd' ||
    documentType === 'cmnd' ||
    documentType === 'passport' ||
    documentType === 'other'
  ) {
    return documentType;
  }

  return null;
}
