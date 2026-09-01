/**
 * Unit tests for Sites cluster LOD + Fast paint helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SITES_CLUSTER_LOD_BANDS,
  _resetPerformanceFastForTest,
  clusterParamsForHeight,
  isPerformanceFastPreset,
  onPerformanceFastChange,
  prioritizeFeaturesNear,
  setPerformanceFastPreset,
  sitesPaintBatchSize,
  sitesPaintYieldMs,
} from './sitesPerformance.js';

describe('clusterParamsForHeight', () => {
  it('uses aggressive clusters at country / SA overview heights', () => {
    const country = clusterParamsForHeight(600_000, { fast: false });
    assert.ok(country.pixelRange >= 100);
    assert.ok(country.minimumClusterSize >= 28);

    const province = clusterParamsForHeight(120_000, { fast: false });
    assert.ok(province.pixelRange >= 70);
    assert.ok(province.minimumClusterSize >= 16);

    const street = clusterParamsForHeight(2_000, { fast: false });
    assert.equal(street.pixelRange, SITES_CLUSTER_LOD_BANDS[0].pixelRange);
    assert.equal(street.minimumClusterSize, SITES_CLUSTER_LOD_BANDS[0].minimumClusterSize);
  });

  it('Fast preset bumps range and minimum cluster size', () => {
    const normal = clusterParamsForHeight(100_000, { fast: false });
    const fast = clusterParamsForHeight(100_000, { fast: true });
    assert.ok(fast.pixelRange > normal.pixelRange);
    assert.ok(fast.minimumClusterSize > normal.minimumClusterSize);
  });
});

describe('performance Fast preset flag', () => {
  it('notifies listeners and sizes paint batches', () => {
    _resetPerformanceFastForTest();
    assert.equal(isPerformanceFastPreset(), false);
    let seen = null;
    const unsub = onPerformanceFastChange((v) => { seen = v; });
    setPerformanceFastPreset(true);
    assert.equal(isPerformanceFastPreset(), true);
    assert.equal(seen, true);
    assert.equal(sitesPaintBatchSize({ streaming: true }), 24);
    assert.ok(sitesPaintYieldMs({ streaming: true }) >= 48);
    setPerformanceFastPreset(false);
    assert.equal(seen, false);
    assert.equal(sitesPaintBatchSize({ streaming: true }), 48);
    unsub();
    _resetPerformanceFastForTest();
  });
});

describe('prioritizeFeaturesNear', () => {
  it('orders nearer points first', () => {
    const features = [
      { geometry: { type: 'Point', coordinates: [28.0, -26.0] } }, // JHB
      { geometry: { type: 'Point', coordinates: [18.4, -33.9] } }, // CT
      { geometry: { type: 'Point', coordinates: [18.5, -33.95] } },
    ];
    const ordered = prioritizeFeaturesNear(features, 18.42, -33.92);
    assert.equal(ordered[0].geometry.coordinates[0], 18.4);
    assert.equal(ordered[ordered.length - 1].geometry.coordinates[0], 28.0);
  });
});
