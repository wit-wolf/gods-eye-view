/**
 * Unit tests for Sites cluster bubble size / label helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSitesClusterBubbleDataUrl,
  resetSitesClusterBubbleCache,
  sitesClusterBubbleCacheKey,
  sitesClusterBubbleLabel,
  sitesClusterBubbleSize,
} from './sitesClusterStyle.js';

describe('sitesClusterBubbleSize', () => {
  it('tiers small / medium / large by count', () => {
    assert.equal(sitesClusterBubbleSize(4).tier, 'small');
    assert.equal(sitesClusterBubbleSize(24).tier, 'small');
    assert.equal(sitesClusterBubbleSize(25).tier, 'medium');
    assert.equal(sitesClusterBubbleSize(119).tier, 'medium');
    assert.equal(sitesClusterBubbleSize(120).tier, 'large');
    assert.equal(sitesClusterBubbleSize(947).tier, 'large');
    assert.ok(sitesClusterBubbleSize(4).diameter < sitesClusterBubbleSize(50).diameter);
    assert.ok(sitesClusterBubbleSize(50).diameter < sitesClusterBubbleSize(200).diameter);
  });

  it('formats labels without inventing values', () => {
    assert.equal(sitesClusterBubbleLabel(883), '883');
    assert.equal(sitesClusterBubbleLabel(12), '12');
    assert.match(sitesClusterBubbleLabel(1200), /1[,.\u00a0]?200|1200/);
  });

  it('cache keys include tier and count', () => {
    assert.match(sitesClusterBubbleCacheKey(883, '#145c56', '#3dd6c6', '#fff'), /^large:883:/);
  });

  it('canvas builder is null in Node (no document) and does not throw', () => {
    resetSitesClusterBubbleCache();
    assert.equal(buildSitesClusterBubbleDataUrl(42), null);
  });
});
