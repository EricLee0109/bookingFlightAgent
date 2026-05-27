const COMMON_SURNAMES = [
  'NGUYEN',
  'TRAN',
  'LE',
  'PHAM',
  'HOANG',
  'HUYNH',
  'PHAN',
  'VU',
  'VO',
  'DANG',
  'BUI',
  'DO',
  'HO',
  'NGO',
  'DUONG',
  'LY',
  'DINH',
  'MAI',
  'TRINH',
  'TRUONG',
  'CAO',
  'LAM',
  'LUU',
  'DAO',
];

const COMMON_MIDDLE_NAMES = [
  'THI',
  'VAN',
  'MINH',
  'HOANG',
  'HUU',
  'DUC',
  'THANH',
  'QUOC',
  'ANH',
];

const GIVEN_NAMES = [
  'LANH',
  'HUONG',
  'TOAN',
  'CHUONG',
  'THONG',
  'AN',
  'ANH',
  'LINH',
  'TRANG',
  'THAO',
  'TUAN',
  'HUNG',
  'DUNG',
  'HA',
  'HOA',
  'PHUONG',
  'NHUNG',
];

const FIRST_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');

/**
 * Builds bootstrap keywords in tiers to work around autocomplete result limits.
 *
 * Searching only common surnames can return a small top slice. Mixed surname,
 * middle-name, first-letter, and given-name seeds make the cache denser.
 */
export function buildPassengerBootstrapSeeds(options: {
  incrementalKeywords?: string[];
} = {}) {
  const seeds = new Set<string>();

  for (const surname of COMMON_SURNAMES) {
    seeds.add(surname);
  }

  for (const surname of COMMON_SURNAMES) {
    for (const middleName of COMMON_MIDDLE_NAMES) {
      seeds.add(`${surname} ${middleName}`);
    }
  }

  for (const surname of COMMON_SURNAMES) {
    for (const letter of FIRST_LETTERS) {
      seeds.add(`${surname} ${letter}`);
    }
  }

  for (const givenName of GIVEN_NAMES) {
    seeds.add(givenName);
  }

  for (const keyword of options.incrementalKeywords ?? []) {
    seeds.add(keyword);
  }

  return Array.from(seeds);
}

/**
 * Returns a small deterministic seed list for local smoke testing.
 */
export function buildPassengerBootstrapSampleSeeds(limit = 20) {
  return buildPassengerBootstrapSeeds().slice(0, limit);
}
