import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapTomTomRoadType,
  simplifyRoadCoords,
  flowSegmentsToRoadSpecs,
} from './tomtomRoads.js';

test('mapTomTomRoadType covers verified TomTom labels', () => {
  assert.equal(mapTomTomRoadType('Motorway'), 'motorway');
  assert.equal(mapTomTomRoadType('Major road'), 'trunk');
  assert.equal(mapTomTomRoadType('Secondary road'), 'secondary');
  assert.equal(mapTomTomRoadType('Major local road'), 'primary');
  assert.equal(mapTomTomRoadType('Connecting road'), 'residential');
  assert.equal(mapTomTomRoadType(''), 'unclassified');
  assert.equal(mapTomTomRoadType(null), 'unclassified');
});

test('simplifyRoadCoords keeps endpoints and caps length', () => {
  const raw = Array.from({ length: 100 }, (_, i) => [i, i]);
  const out = simplifyRoadCoords(raw, 10);
  assert.ok(out.length <= 11);
  assert.deepEqual(out[0], raw[0]);
  assert.deepEqual(out[out.length - 1], raw[raw.length - 1]);
});

test('flowSegmentsToRoadSpecs attaches live flow and skips empty geometry', () => {
  const roads = flowSegmentsToRoadSpecs([
    {
      coords: [[18.42, -33.92], [18.43, -33.93]],
      trafficLevel: 0.4,
      roadType: 'Major road',
      closure: false,
    },
    {
      coords: [[0, 0]],
      trafficLevel: 1,
      roadType: 'Motorway',
      closure: false,
    },
    {
      coords: [[22.46, -33.96], [22.47, -33.97]],
      trafficLevel: 0,
      roadType: 'Connecting road',
      closure: true,
    },
  ]);
  assert.equal(roads.length, 2);
  assert.equal(roads[0].type, 'trunk');
  assert.equal(roads[0].source, 'tomtom');
  assert.equal(roads[0].oneway, 1);
  assert.deepEqual(roads[0].flow, { level: 0.4, closure: false });
  assert.equal(roads[1].flow.closure, true);
  assert.equal(roads[1].type, 'residential');
});
