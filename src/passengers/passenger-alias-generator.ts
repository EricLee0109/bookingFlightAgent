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
}) {
  const aliases = new Map<string, PassengerAliasInput>();
  const normalizedLastName = normalizePassengerText(input.lastName);
  const normalizedFirstName = normalizePassengerText(input.firstName);
  const normalizedFullName = buildPassengerFullName(
    input.lastName,
    input.firstName,
  );
  const firstNameTokens = normalizedFirstName.split(' ').filter(Boolean);
  const givenName = firstNameTokens.at(-1);

  addAlias(aliases, input.passengerProfileId, normalizedFullName, 'full_name');
  addAlias(aliases, input.passengerProfileId, normalizedFirstName, 'first_name');

  if (givenName) {
    addAlias(aliases, input.passengerProfileId, givenName, 'given_name');
  }

  if (normalizedLastName) {
    addAlias(aliases, input.passengerProfileId, normalizedLastName, 'last_name');
  }

  return Array.from(aliases.values());
}

function addAlias(
  aliases: Map<string, PassengerAliasInput>,
  passengerProfileId: number,
  aliasText: string,
  aliasType: PassengerAliasInput['aliasType'],
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
  });
}
