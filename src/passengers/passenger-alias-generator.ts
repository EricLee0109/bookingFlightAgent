import { type PassengerAliasInput } from './passenger-types';
import {
  buildPassengerFullName,
  normalizePassengerText,
} from './passenger-normalization';

/**
 * Generates local search aliases for one passenger profile.
 *
 * Aliases are intentionally simple and deterministic. The resolver should be
 * able to match "LANH" while still keeping the full canonical name available.
 */
export function generatePassengerAliases(input: {
  passengerProfileId: number;
  lastName: string;
  firstName: string;
  rawMention?: string | null;
}) {
  const aliases = new Map<string, PassengerAliasInput>();
  const normalizedLastName = normalizePassengerText(input.lastName);
  const normalizedFirstName = normalizePassengerText(input.firstName);
  const normalizedFullName = buildPassengerFullName(
    input.lastName,
    input.firstName,
  );
  const firstNameTokens = normalizedFirstName.split(' ').filter(Boolean);
  const fullNameTokens = normalizedFullName.split(' ').filter(Boolean);
  const givenName = firstNameTokens.at(-1);
  const lastTwoTokens = fullNameTokens.slice(-2).join(' ');

  addAlias(aliases, input.passengerProfileId, normalizedFullName, 'full_name', 100);
  addAlias(aliases, input.passengerProfileId, normalizedFirstName, 'first_name', 85);

  if (givenName) {
    addAlias(aliases, input.passengerProfileId, givenName, 'given_name', 70);
    addAlias(
      aliases,
      input.passengerProfileId,
      `${normalizedLastName} ${givenName}`,
      'family_given_name',
      80,
    );
  }

  if (normalizedLastName) {
    addAlias(aliases, input.passengerProfileId, normalizedLastName, 'last_name', 45);
  }

  if (lastTwoTokens) {
    addAlias(
      aliases,
      input.passengerProfileId,
      lastTwoTokens,
      'last_two_tokens',
      75,
    );
  }

  if (input.rawMention) {
    addAlias(
      aliases,
      input.passengerProfileId,
      input.rawMention,
      'manual_mention',
      90,
    );
  }

  return Array.from(aliases.values());
}

function addAlias(
  aliases: Map<string, PassengerAliasInput>,
  passengerProfileId: number,
  aliasText: string,
  aliasType: PassengerAliasInput['aliasType'],
  weight: number,
) {
  const normalizedAlias = normalizePassengerText(aliasText);

  if (!normalizedAlias) {
    return;
  }

  aliases.set(`${aliasType}:${normalizedAlias}`, {
    passengerProfileId,
    aliasText: normalizedAlias,
    normalizedAlias,
    aliasType,
    weight,
  });
}
