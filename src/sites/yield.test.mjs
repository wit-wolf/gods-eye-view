import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAbortError,
  mapInBatches,
  sampleFeaturesForPreview,
  yieldToMain,
} from './yield.js';

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
