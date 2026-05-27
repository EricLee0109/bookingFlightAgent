import { sanitizeObservedPassengerQuery } from './passenger-normalization';
import { type PassengerStore } from './passenger-store';
import { type PassengerResolveResult } from './passenger-types';

/**
 * Resolves passenger text against the local cache before any form fill step.
 *
 * The resolver stores confidence evidence in SQLite, but it does not mutate the
 * passenger profile itself unless another component provides updated fields.
 */
export class PassengerResolver {
  constructor(private readonly store: PassengerStore) {}

  /**
   * Resolves one alias-style passenger query such as `LANH`.
   */
  resolve(rawQuery: string): PassengerResolveResult {
    const observedQuery = sanitizeObservedPassengerQuery(rawQuery);
    const candidates = this.findCandidatesByQueryAliases(observedQuery);

    if (candidates.length === 1) {
      const profile = candidates[0];
      const hasMissingRequiredFields =
        !profile.dateOfBirth || !profile.documentNumber;
      const confidenceScore = hasMissingRequiredFields ? 0.82 : 0.95;
      const reason = hasMissingRequiredFields
        ? 'missing_required_field'
        : 'exact_alias';

      this.store.insertConfidenceScore({
        passengerProfileId: profile.id,
        score: confidenceScore,
        reason,
        source: 'operator_input',
        observedQuery,
      });

      return {
        ok: true,
        profile,
        confidenceScore,
        reason,
      };
    }

    if (candidates.length > 1) {
      for (const candidate of candidates) {
        this.store.insertConfidenceScore({
          passengerProfileId: candidate.id,
          score: 0.45,
          reason: 'ambiguous_candidate',
          source: 'operator_input',
          observedQuery,
        });
      }

      return {
        ok: false,
        confidenceScore: 0.45,
        reason: 'ambiguous_candidate',
        candidates,
      };
    }

    return {
      ok: false,
      confidenceScore: 0,
      reason: 'no_match',
      candidates: [],
    };
  }

  private findCandidatesByQueryAliases(observedQuery: string) {
    const profilesById = new Map<number, ReturnType<PassengerStore['findProfilesByAlias']>[number]>();

    for (const alias of buildLookupAliases(observedQuery)) {
      for (const profile of this.store.findProfilesByAlias(alias)) {
        profilesById.set(profile.id, profile);
      }
    }

    return Array.from(profilesById.values());
  }
}

const PASSENGER_QUERY_STOP_WORDS = new Set([
  'CHI',
  'ANH',
  'CO',
  'CHU',
  'ONG',
  'BA',
  'EM',
  'KHACH',
  'BAY',
  'CHUYEN',
  'NAY',
]);

/**
 * Builds alias lookup candidates from short operator text.
 *
 * Example: `CHI LANH BAY CHUYEN NAY` should still lookup `LANH`.
 */
function buildLookupAliases(observedQuery: string) {
  const tokens = observedQuery
    .split(' ')
    .filter((token) => token && !PASSENGER_QUERY_STOP_WORDS.has(token));
  const aliases = new Set<string>();

  if (observedQuery) {
    aliases.add(observedQuery);
  }

  if (tokens.length > 0) {
    aliases.add(tokens.join(' '));
  }

  for (const token of tokens) {
    aliases.add(token);
  }

  return Array.from(aliases);
}
