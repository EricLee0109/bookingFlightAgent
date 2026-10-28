import assert from 'node:assert/strict';
import {
  normalizePreferredAirlineCodes,
  resolveAirlineCodeOrText,
  resolveAirlineFromText,
} from '../src/agent/airline-catalog';
import { parseFlightCardText } from '../src/automation/1booking/flight-card-parser';

/** Mirrors the recorded 1Booking cards that were omitted from the snapshot. */
const RECORDED_SUN_CARD_FIXTURES = [
  `Sun PhuQuoc Airways
9G
9G802
32Q
05:15
SGN
2h10m
Bay thẳng
07:25
HAN
VND
1,243,181
(V)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G808
A321
06:30
SGN
2h10m
Bay thẳng
08:40
HAN
VND
1,243,181
(V)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G882
A321
21:55
SGN
2h10m
Bay thẳng
00:05
+1
HAN
VND
1,243,181
(V)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G894
32N
23:30
SGN
2h10m
Bay thẳng
01:40
+1
HAN
VND
1,243,181
(V)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G810
32Q
07:30
SGN
2h5m
Bay thẳng
09:35
HAN
VND
1,481,181
(U)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G830
32Q
10:50
SGN
2h10m
Bay thẳng
13:00
HAN
VND
1,481,181
(U)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G840
A321
12:25
SGN
2h10m
Bay thẳng
14:35
HAN
VND
1,481,181
(U)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G854
A321
15:30
SGN
2h10m
Bay thẳng
17:40
HAN
VND
1,481,181
(U)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G864
32N
17:40
SGN
2h10m
Bay thẳng
19:50
HAN
VND
1,481,181
(U)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G824
A321
09:25
SGN
2h10m
Bay thẳng
11:35
HAN
VND
1,675,181
(R)
9
Chọn ngay
Xem thêm`,
  `Sun PhuQuoc Airways
9G
9G868
A321
18:45
SGN
2h10m
Bay thẳng
20:55
HAN
VND
1,837,181
(O)
9
Chọn ngay
Xem thêm`,
] as const;

/** Verifies every recorded 9G card becomes a supported current candidate. */
function testRecordedSunCards() {
  const candidates = RECORDED_SUN_CARD_FIXTURES.map((cardText, cardIndex) =>
    parseFlightCardText(cardIndex, cardText),
  );

  assert.equal(candidates.filter(Boolean).length, RECORDED_SUN_CARD_FIXTURES.length);
  assert.deepEqual(
    candidates.map((candidate) => candidate?.airlineCode),
    RECORDED_SUN_CARD_FIXTURES.map(() => '9G'),
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate?.flightNumber),
    ['9G802', '9G808', '9G882', '9G894', '9G810', '9G830', '9G840', '9G854', '9G864', '9G824', '9G868'],
  );
  assert.equal(candidates[0]?.airlineName, 'Sun PhuQuoc Airways');
  assert.equal(candidates[0]?.rawBookingClassCode, 'V');
  assert.equal(candidates[0]?.priceAmount, 1_243_181);
}

/** Verifies legacy 9S cards and explicit code precedence remain deterministic. */
function testSunAliasesAndLegacyCards() {
  const historicalCard = parseFlightCardText(
    99,
    'Sun Phu Quoc Airways 9S622 A320 19:00 SGN 20:20 DAD VND 1,480,781 (B)',
  );

  assert.equal(historicalCard?.airlineCode, '9S');
  assert.equal(historicalCard?.flightNumber, '9S622');
  assert.equal(resolveAirlineFromText('khách muốn bay Sun')?.code, '9G');
  assert.equal(resolveAirlineFromText('Sun PhuQuoc Airways 9S622')?.code, '9S');
  assert.equal(resolveAirlineCodeOrText('9G')?.code, '9G');
  assert.equal(resolveAirlineCodeOrText('9S')?.code, '9S');
  assert.deepEqual(normalizePreferredAirlineCodes(['Sun']), ['9G']);
  assert.deepEqual(normalizePreferredAirlineCodes(['9S']), ['9S']);
}

testRecordedSunCards();
testSunAliasesAndLegacyCards();
console.log('1Booking airline card tests passed.');
