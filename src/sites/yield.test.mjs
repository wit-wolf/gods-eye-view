import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAbortError,
  mapInBatches,
  sampleFeaturesForPreview,
  yieldToMain,
} from './yield.js';
import { dedupeFeaturesByUid } from './sitesLayer.js';
import { generateFeatureUID, processGeoJSON } from './importKml.js';

function point(lon, lat, name = 'p') {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

test('sampleFeaturesForPreview prefers Cape Town and respects limit', () => {
  const features = [
    point(18.42, -33.92, 'ct1'),
    point(18.45, -33.95, 'ct2'),
    point(28.0, -26.2, 'jhb'),
    point(31.0, -29.8, 'dbn'),
    point(18.5, -33.9, 'ct3'),
  ];
  const sample = sampleFeaturesForPreview(features, 3);
  assert.equal(sample.length, 3);
  assert.equal(sample.filter((f) => f.properties.name.startsWith('ct')).length, 3);
});

test('sampleFeaturesForPreview returns all when under limit', () => {
  const features = [point(1, 1), point(2, 2)];
  assert.equal(sampleFeaturesForPreview(features, 500).length, 2);
});

test('mapInBatches yields between batches and reports progress', async () => {
  const seen = [];
  const progress = [];
  await mapInBatches([1, 2, 3, 4, 5], {
    batchSize: 2,
    work: async (batch) => { seen.push([...batch]); },
    onProgress: (p) => progress.push(p.done),
  });
  assert.deepEqual(seen, [[1, 2], [3, 4], [5]]);
  assert.deepEqual(progress, [2, 4, 5]);
});

test('mapInBatches / yieldToMain honour AbortSignal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => yieldToMain({ signal: controller.signal }),
    (error) => isAbortError(error),
  );
  await assert.rejects(
    () => mapInBatches([1, 2, 3], {
      batchSize: 1,
      signal: controller.signal,
      work: async () => {},
    }),
    (error) => isAbortError(error),
  );
});

test('dedupeFeaturesByUid keeps first occurrence of each _uid', () => {
  const features = [
    { properties: { _uid: 'a' }, geometry: { type: 'Point', coordinates: [1, 1] } },
    { properties: { _uid: 'b' }, geometry: { type: 'Point', coordinates: [2, 2] } },
    { properties: { _uid: 'a' }, geometry: { type: 'Point', coordinates: [1, 1] } },
    { properties: { _uid: 'c' }, geometry: { type: 'Point', coordinates: [3, 3] } },
  ];
  const deduped = dedupeFeaturesByUid(features);
  assert.equal(deduped.length, 3);
  assert.deepEqual(deduped.map((f) => f.properties._uid), ['a', 'b', 'c']);
});

test('preview and full processGeoJSON share stable uids for the same pin', () => {
  const hotel = {
    type: 'Feature',
    properties: { name: 'Morning Star Hotel', _name: 'Morning Star Hotel' },
    geometry: { type: 'Point', coordinates: [18.4241, -33.9249, 0] },
  };
  const preview = processGeoJSON({ type: 'FeatureCollection', features: [hotel] }, 'demo-november-pins');
  const full = processGeoJSON({
    type: 'FeatureCollection',
    features: [hotel, point(18.5, -33.9, 'Other')],
  }, 'demo-november-pins');
  assert.equal(preview.features[0].properties._uid, full.features[0].properties._uid);
  assert.match(preview.features[0].properties._uid, /^demo-november-pins:Morning Star Hotel:/);
  const merged = dedupeFeaturesByUid([...preview.features, ...full.features]);
  assert.equal(merged.length, 2);
});

test('generateFeatureUID falls back to _name', () => {
  const uid = generateFeatureUID({
    properties: { _name: 'Only Name' },
    geometry: { type: 'Point', coordinates: [0, 0] },
  }, 'L', 0);
  assert.match(uid, /^L:Only Name:/);
});
