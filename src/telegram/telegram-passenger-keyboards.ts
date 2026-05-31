import { type PassengerProfile } from '../passengers/passenger-types';

const CALLBACK_PREFIX = 'p';

export type PassengerCallbackAction = 'choose' | 'confirm';

export type PassengerCallbackPayload = {
  action: PassengerCallbackAction;
  caseId: string;
  passengerProfileId: number;
};

/**
 * Builds inline buttons for ambiguous local passenger candidates.
 */
export function buildPassengerCandidateKeyboard(
  caseId: string,
  profiles: PassengerProfile[],
) {
  return {
    inline_keyboard: profiles.slice(0, 5).map((profile) => [
      {
        text: formatPassengerButtonLabel(profile),
        callback_data: buildPassengerCallbackData('choose', caseId, profile.id),
      },
    ]),
  };
}

/**
 * Builds the final operator confirmation button for one ready profile.
 */
export function buildPassengerConfirmationKeyboard(
  caseId: string,
  profile: PassengerProfile,
) {
  return {
    inline_keyboard: [
      [
        {
          text: 'Dùng khách này',
          callback_data: buildPassengerCallbackData('confirm', caseId, profile.id),
        },
      ],
    ],
  };
}

/**
 * Parses compact callback data emitted by passenger inline buttons.
 */
export function parsePassengerCallbackData(
  callbackData: string,
): PassengerCallbackPayload | null {
  const match = callbackData.match(
    /^p:(choose|confirm):(BK-\d{8}-\d{6}):(\d+)$/i,
  );

  if (!match) {
    return null;
  }

  return {
    action: match[1].toLowerCase() as PassengerCallbackAction,
    caseId: match[2].toUpperCase(),
    passengerProfileId: Number(match[3]),
  };
}

function buildPassengerCallbackData(
  action: PassengerCallbackAction,
  caseId: string,
  passengerProfileId: number,
) {
  return `${CALLBACK_PREFIX}:${action}:${caseId}:${passengerProfileId}`;
}

function formatPassengerButtonLabel(profile: PassengerProfile) {
  const dob = profile.dateOfBirth ? ` - ${profile.dateOfBirth}` : '';

  return `${profile.normalizedFullName} (${profile.title})${dob}`;
}
