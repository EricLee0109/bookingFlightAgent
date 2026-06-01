import {
  buildPassengerFullName,
  normalizePassengerText,
  sanitizeObservedPassengerQuery,
} from './passenger-normalization';
import { type PassengerStore } from './passenger-store';
import {
  type ConfidenceReason,
  type PassengerProfile,
  type PassengerResolveResult,
} from './passenger-types';

type ScoredPassengerCandidate = {
  profile: PassengerProfile;
  score: number;
  reason: ConfidenceReason;
};

export type PassengerResolverOptions = {
  excludeProfileIds?: number[];
};

/**
 * Resolves passenger mentions against the local SQLite cache.
 *
 * Resolution order:
 * - Exact alias
 * - Exact canonical full name
 * - Token match
 * - Given-name match
 * - Fuzzy match
 *
 * This component decides local passenger candidates. AI parser output is only
 * descriptive input and is never trusted as a final DB match.
 */
export class PassengerResolver {
  constructor(private readonly store: PassengerStore) {}

  /**
   * Resolves one passenger mention into a domain result for Telegram.
   */
  resolve(
    rawQuery: string,
    options: PassengerResolverOptions = {},
  ): PassengerResolveResult {
    const observedQuery = sanitizeObservedPassengerQuery(rawQuery);
    const lookupQuery = removePassengerQueryStopWords(observedQuery);
    const excludedIds = new Set(options.excludeProfileIds ?? []);

    if (!lookupQuery) {
      return createNotFoundResult();
    }

    const candidates = this.scoreCandidates(lookupQuery).filter(
      (candidate) => !excludedIds.has(candidate.profile.id),
    );
    const topCandidate = candidates[0];

    if (!topCandidate || topCandidate.score < 0.58) {
      return createNotFoundResult();
    }

    const closeCandidates = candidates.filter(
      (candidate) =>
        candidate.score >= 0.58 &&
        topCandidate.score - candidate.score < 0.12,
    );

    if (closeCandidates.length > 1) {
      const profiles = closeCandidates.slice(0, 5).map(({ profile }) => profile);

      for (const profile of profiles) {
        this.store.insertConfidenceScore({
          passengerProfileId: profile.id,
          score: topCandidate.score,
          reason: 'ambiguous_candidate',
          source: 'operator_input',
          observedQuery: lookupQuery,
        });
      }

      return {
        status: 'ambiguous',
        confidenceScore: topCandidate.score,
        reason: 'ambiguous_candidate',
        candidates: profiles,
        missingFields: [],
      };
    }

    const missingFields = getMissingRequiredPassengerFields(
      topCandidate.profile,
    );
    const reason =
      missingFields.length > 0 ? 'missing_required_field' : topCandidate.reason;

    this.store.insertConfidenceScore({
      passengerProfileId: topCandidate.profile.id,
      score: topCandidate.score,
      reason,
      source: 'operator_input',
      observedQuery: lookupQuery,
    });

    if (missingFields.length > 0) {
      return {
        status: 'matched_but_missing_fields',
        profile: topCandidate.profile,
        confidenceScore: topCandidate.score,
        reason: 'missing_required_field',
        missingFields,
      };
    }

    return {
      status: 'matched',
      profile: topCandidate.profile,
      confidenceScore: topCandidate.score,
      reason: topCandidate.reason,
      missingFields: [],
    };
  }

  private scoreCandidates(lookupQuery: string) {
    const scoredById = new Map<number, ScoredPassengerCandidate>();
    const exactAliases = this.store.findProfilesByAlias(lookupQuery);
    const exactFullNames =
      this.store.findProfilesByNormalizedFullName(lookupQuery);
    const profiles = this.store.listPassengerProfiles();

    for (const profile of exactAliases) {
      setHigherScore(scoredById, profile, 1, 'exact_alias');
    }

    for (const profile of exactFullNames) {
      setHigherScore(scoredById, profile, 0.98, 'full_name_exact');
    }

    for (const profile of profiles) {
      const score = scorePassengerProfile(profile, lookupQuery);

      if (score) {
        setHigherScore(scoredById, profile, score.score, score.reason);
      }
    }

    return Array.from(scoredById.values()).sort(
      (left, right) =>
        right.score - left.score ||
        right.profile.seenCount - left.profile.seenCount ||
        left.profile.id - right.profile.id,
    );
  }
}

/**
 * Returns fields that must exist before later Playwright passenger form fill.
 *
 * DOB stays optional in the lean hold-booking MVP.
 */
export function getMissingRequiredPassengerFields(profile: PassengerProfile) {
  const missingFields: string[] = [];

  if (!profile.normalizedFullName) missingFields.push('fullName');
  if (profile.gender === null) missingFields.push('gender');

  return missingFields;
}

function scorePassengerProfile(
  profile: PassengerProfile,
  lookupQuery: string,
): Pick<ScoredPassengerCandidate, 'score' | 'reason'> | null {
  const queryTokens = lookupQuery.split(' ').filter(Boolean);
  const fullName = profile.normalizedFullName;
  const fullNameTokens = fullName.split(' ').filter(Boolean);
  const givenName = profile.normalizedFirstName.split(' ').filter(Boolean).at(-1);

  if (fullName === lookupQuery) {
    return {
      score: 0.98,
      reason: 'full_name_exact',
    };
  }

  if (
    queryTokens.length > 1 &&
    queryTokens.every((token) => fullNameTokens.includes(token))
  ) {
    return {
      score: 0.86,
      reason: 'token_match',
    };
  }

  if (queryTokens.length === 1 && givenName === lookupQuery) {
    return {
      score: 0.82,
      reason: 'unique_given_name',
    };
  }

  const similarity = calculateSimilarity(
    lookupQuery,
    buildPassengerFullName(profile.lastName, profile.firstName),
  );

  if (similarity >= 0.58) {
    return {
      score: Math.min(0.79, similarity),
      reason: 'fuzzy_match',
    };
  }

  return null;
}

function setHigherScore(
  candidates: Map<number, ScoredPassengerCandidate>,
  profile: PassengerProfile,
  score: number,
  reason: ConfidenceReason,
) {
  const previous = candidates.get(profile.id);

  if (!previous || score > previous.score) {
    candidates.set(profile.id, {
      profile,
      score,
      reason,
    });
  }
}

function calculateSimilarity(left: string, right: string) {
  const longestLength = Math.max(left.length, right.length);

  if (longestLength === 0) {
    return 1;
  }

  return 1 - calculateLevenshteinDistance(left, right) / longestLength;
}

function calculateLevenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function createNotFoundResult(): PassengerResolveResult {
  return {
    status: 'not_found',
    confidenceScore: 0,
    reason: 'no_match',
    candidates: [],
    missingFields: [],
  };
}

const PASSENGER_QUERY_STOP_WORDS = new Set([
  'ANH',
  'A',
  'CHI',
  'C',
  'CO',
  'CHU',
  'BAC',
  'EM',
  'BE',
  'ONG',
  'BA',
  'KHACH',
  'LA',
  'LAY',
  'DUNG',
  'CHO',
  'CASE',
  'NAY',
  'NHA',
  'BAY',
  'CHUYEN',
  'TIM',
  'LAI',
  'KHAC',
]);

/**
 * Removes honorifics and common operator words before local profile matching.
 */
function removePassengerQueryStopWords(observedQuery: string) {
  return normalizePassengerText(observedQuery)
    .split(' ')
    .filter((token) => token && !PASSENGER_QUERY_STOP_WORDS.has(token))
    .join(' ');
}
