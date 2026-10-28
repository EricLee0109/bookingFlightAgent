import assert from 'node:assert/strict';
import { ParsedFlightRequestSchema } from '../src/contracts/flight';
import {
  AIRPORT_CATALOG,
} from '../src/agent/airport-catalog';
import {
  normalizeAirportText,
  resolveAirportByCode,
  resolveAirportFromText,
} from '../src/agent/airport-resolver';
import {
  normalizeHybridRequest,
  validateHybridFlightRequest,
  type HybridSearchFlightRequest,
} from '../src/agent/hybrid-flight-request';
import { buildFlightParserSystemPrompt } from '../src/agent/openai-flight-request-parser';
import { buildHybridInstructions, type HybridSearchAgentContext } from '../src/agent/hybrid-search-agent';
import { createEmptyHybridSearchSession } from '../src/storage/hybrid-search-session-store';
import { normalizeParsedAirportFieldsForSearch } from '../src/agent/search-flight-input-mapper';

function testVietnameseDiacriticsAndAliases() {
  assert.equal(normalizeAirportText('ĐÀ NẴNG'), 'da nang');
  assert.equal(resolveAirportFromText('Đà Nẵng')?.code, 'DAD');
  assert.equal(resolveAirportFromText('da nang')?.code, 'DAD');
  assert.equal(resolveAirportFromText('DA NANG')?.code, 'DAD');
  assert.equal(resolveAirportFromText('ĐN')?.code, 'DAD');
  assert.equal(resolveAirportFromText('dn')?.code, 'DAD');
  assert.equal(resolveAirportFromText('DAD')?.code, 'DAD');
  assert.equal(resolveAirportFromText('hcm')?.code, 'SGN');
  assert.equal(resolveAirportFromText('HCM')?.code, 'SGN');
  assert.equal(resolveAirportFromText('hn')?.code, 'HAN');
  assert.equal(resolveAirportFromText('HN')?.code, 'HAN');
  assert.equal(resolveAirportFromText('Đồng Hới')?.code, 'VDH');
  assert.equal(resolveAirportFromText('Điện Biên')?.code, 'DIN');
}

function testShortAliasesRemainWholeTokens() {
  assert.equal(resolveAirportFromText('adnanced'), null);
  assert.equal(resolveAirportFromText('hcmcity'), null);
  assert.equal(resolveAirportFromText('thanh'), null);
}

function testCanonicalCatalogLabelsResolve() {
  for (const airport of AIRPORT_CATALOG) {
    assert.equal(
      resolveAirportFromText(airport.text)?.code,
      airport.code,
      `canonical label should resolve: ${airport.text}`,
    );
  }
}

function testTextOnlyDestinationRecovery() {
  const rawText = 'từ hcm ra đà nẵng ngày20/2';
  const request: HybridSearchFlightRequest = {
    fromAirportCode: 'SGN',
    fromAirportText: 'HCM',
    toAirportCode: null,
    toAirportText: 'đà nẵng',
    departureDate: '2027-02-20',
    returnDate: null,
    preferredTime: null,
    specificTime: null,
    resultRanking: null,
    preferredAirlineCodes: null,
    tripType: 'one_way',
    missingFields: ['toAirportCode'],
    timeConstraint: null,
  };

  const normalized = normalizeHybridRequest(request, rawText);
  assert.equal(normalized.fromAirportCode, 'SGN');
  assert.equal(normalized.toAirportCode, 'DAD');
  assert.equal(normalized.toAirportText, 'Da Nang International Airport (DAD)');

  const validated = validateHybridFlightRequest(request, {
    rawText,
    todayIso: '2027-01-01',
  });
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.request.fromAirportCode, 'SGN');
    assert.equal(validated.request.toAirportCode, 'DAD');
    assert.equal(validated.request.toAirportText, 'Da Nang International Airport (DAD)');
  }

  const legacy = normalizeParsedAirportFieldsForSearch(
    ParsedFlightRequestSchema.parse(request),
  );
  assert.equal(legacy.fromAirportCode, 'SGN');
  assert.equal(legacy.toAirportCode, 'DAD');
  assert.equal(legacy.toAirportText, 'Da Nang International Airport (DAD)');
  assert.deepEqual(legacy.missingFields, []);
}


/** Real chat spellings that previously had no matching alias. */
function testJoinedNames() {
  const examples: Record<string, string> = {
    tranoc: 'VCA', lienkhuong: 'DLI', danang: 'DAD', catbi: 'HPH',
    vandon: 'VDO', noibai: 'HAN', hochiminh: 'SGN', tansonnhat: 'SGN',
    'tp. hcm': 'SGN', phubai: 'HUI', camranh: 'CXR', phuquoc: 'PQC',
    nghean: 'VII', buonmathuot: 'BMV', tuyhoa: 'TBB', camau: 'CAH',
    chulai: 'VCL', condao: 'VCS', vungtau: 'VTG', dienbien: 'DIN',
    donghoi: 'VDH', gialai: 'PXU', quynhon: 'UIH', quinhon: 'UIH',
    phucat: 'UIH', rachgia: 'VKG', thoxuan: 'THD', phanrang: 'PHA',
    longthanh: 'LTH',
  };
  for (const [alias, code] of Object.entries(examples)) {
    assert.equal(resolveAirportFromText(alias)?.code, code, alias);
  }
}

/** All aliases must keep one catalog owner and work through both search paths. */
function testEntireAliasCatalog() {
  const codes = new Set<string>();
  const aliasOwners = new Map<string, string>();
  for (const airport of AIRPORT_CATALOG) {
    assert.match(airport.code, /^[A-Z]{3}$/);
    assert.ok(!codes.has(airport.code), 'duplicate airport code: ' + airport.code);
    codes.add(airport.code);
    assert.ok(airport.text.endsWith('(' + airport.code + ')'));
    assert.equal(resolveAirportByCode(' ' + airport.code.toLowerCase() + ' ')?.text, airport.text);
    assert.equal(new Set(airport.aliases.map(alias => alias.toLowerCase())).size, airport.aliases.length, 'redundant case-only alias');
    for (const alias of airport.aliases) {
      assert.ok(alias.trim().length > 0);
      assert.equal(alias, alias.trim());
      const key = normalizeAirportText(alias);
      const owner = aliasOwners.get(key);
      assert.ok(!owner || owner === airport.code, 'cross-airport alias collision: ' + alias);
      aliasOwners.set(key, airport.code);
      const variants = new Set([
        alias, alias.toUpperCase(), alias.toLowerCase(), alias.normalize('NFD'),
        key, 'sân bay ' + alias + ' nhé',
      ]);
      for (const variant of variants) {
        assert.deepEqual(resolveAirportFromText(variant), {
          code: airport.code, text: airport.text,
        }, 'wrong airport for: ' + variant);
      }
      // Resolve names with no supplied IATA code so code-first lookup cannot hide a missing alias.
      for (const side of ['from', 'to'] as const) {
        const other = airport.code === 'SGN' ? 'HAN' : 'SGN';
        const request: HybridSearchFlightRequest = {
          fromAirportCode: other, fromAirportText: other,
          toAirportCode: other, toAirportText: other,
          [side + 'AirportCode']: null, [side + 'AirportText']: alias,
          departureDate: '2027-02-20', returnDate: null,
          preferredTime: null, specificTime: null, resultRanking: null,
          preferredAirlineCodes: null, tripType: 'one_way', timeConstraint: null,
          missingFields: [side + 'AirportCode'],
        };
        const hybrid = validateHybridFlightRequest(request, { todayIso: '2027-01-01' });
        assert.ok(hybrid.ok, 'hybrid must resolve: ' + alias);
        if (!hybrid.ok) continue;
        const legacy = normalizeParsedAirportFieldsForSearch(ParsedFlightRequestSchema.parse(request));
        assert.deepEqual(legacy.missingFields, []);
        for (const normalized of [hybrid.request, legacy]) {
          assert.equal(normalized[side === 'from' ? 'fromAirportCode' : 'toAirportCode'], airport.code);
          assert.equal(normalized[side === 'from' ? 'fromAirportText' : 'toAirportText'], airport.text);

        }
      }
    }
  }
  assert.equal(codes.size, AIRPORT_CATALOG.length);
}

/** Both model entry points must receive the aliases from the same catalog. */
function testAliasPromptPropagation() {
  const context = {
    chatId: 1, text: 'xin chào', session: createEmptyHybridSearchSession(1),
    sessionStore: {} as HybridSearchAgentContext['sessionStore'],
    automation: async () => { throw new Error('No live automation in catalog tests'); },
    settingsReader: async () => ({
      agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false,
      requireConfirmationBeforeHold: true, debugMode: false,
    }),
    now: new Date('2026-09-16T00:00:00Z'), liveSearchPerformed: false,
  } satisfies HybridSearchAgentContext;
  const hybrid = buildHybridInstructions(context);
  const legacy = buildFlightParserSystemPrompt('2026-09-16', 'Asia/Saigon');
  for (const airport of AIRPORT_CATALOG) {
    assert.ok(hybrid.includes(JSON.stringify({ code: airport.code, text: airport.text, aliases: airport.aliases })));
    assert.ok(legacy.includes(airport.aliases.join(', ') + ' => ' + airport.code + ' / ' + airport.text));
  }
}

testJoinedNames();
testEntireAliasCatalog();
testAliasPromptPropagation();
testVietnameseDiacriticsAndAliases();
testShortAliasesRemainWholeTokens();
testCanonicalCatalogLabelsResolve();
testTextOnlyDestinationRecovery();
console.log('Airport contracts passed: ' + AIRPORT_CATALOG.length + ' airports, ' + AIRPORT_CATALOG.reduce((total, airport) => total + airport.aliases.length, 0) + ' aliases; case/NFD/ASCII variants, ownership, both route sides, legacy/hybrid parity and both prompts.');
