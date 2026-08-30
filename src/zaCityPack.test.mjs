import assert from 'node:assert/strict';
import { CITY_POIS, DEFAULT_HOME_CITY_ID, LOCATIONS, findPoiByName } from './locations.js';

const REQUIRED_ZA_CITIES = [
  'cape-town',
  'johannesburg',
  'durban',
  'pretoria',
  'george',
];

const REQUIRED_LANDMARKS = [
  ['cape-town', 'Table Mountain'],
  ['cape-town', 'V&A Waterfront'],
  ['cape-town', 'Parliament of South Africa'],
  ['cape-town', 'Cape Town International'],
  ['cape-town', 'Signal Hill'],
  ['johannesburg', 'Sandton'],
  ['johannesburg', 'OR Tambo International'],
  ['johannesburg', 'Constitutional Court / Joburg CBD'],
  ['durban', 'Durban Harbour'],
  ['durban', 'Moses Mabhida Stadium'],
  ['pretoria', 'Union Buildings'],
  ['george', 'George Airport'],
  ['george', 'George Town Centre'],
];

assert.equal(DEFAULT_HOME_CITY_ID, 'cape-town');
assert.ok(CITY_POIS['cape-town'], 'Cape Town city pack missing');

for (const cityId of REQUIRED_ZA_CITIES) {
  const city = CITY_POIS[cityId];
  assert.ok(city, `missing ZA city ${cityId}`);
  assert.ok(Array.isArray(city.pois) && city.pois.length > 0, `${cityId} needs POIs`);
  for (const poi of city.pois) {
    assert.ok(Number.isFinite(poi.lat) && Number.isFinite(poi.lon), `${poi.name} coords`);
    assert.ok(poi.lat < 0 && poi.lon > 0, `${poi.name} should be in southern Africa`);
  }
}

for (const [cityId, landmark] of REQUIRED_LANDMARKS) {
  const found = CITY_POIS[cityId].pois.some((poi) => poi.name === landmark);
  assert.ok(found, `${cityId} missing landmark ${landmark}`);
}

// Location bar should list ZA cities before upstream Austin.
const locationIds = LOCATIONS.map((entry) => entry.id);
assert.ok(locationIds.indexOf('cape-town') < locationIds.indexOf('austin'));

assert.deepEqual(
  findPoiByName('fly to Table Mountain'),
  { cityId: 'cape-town', index: 0 },
);
assert.deepEqual(
  findPoiByName('Union Buildings Pretoria'),
  { cityId: 'pretoria', index: 0 },
);

console.log('zaCityPack.test.mjs: ok');
