/**
 * Unit tests for Sites research helpers (pure formatting).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCompetitorListHtml } from './siteResearch.js';

describe('formatCompetitorListHtml', () => {
  it('renders name + distance rows', () => {
    const html = formatCompetitorListHtml([
      { name: 'Checkers', distanceM: 420, primaryType: 'supermarket' },
      { name: 'Builders', distanceM: 1800, primaryType: null },
    ], 8, (v) => String(v).replace(/</g, '&lt;'));
    assert.match(html, /Checkers/);
    assert.match(html, /supermarket/);
    assert.match(html, /Builders/);
    assert.match(html, /420|0\.4/);
  });

  it('returns empty string for no places', () => {
    assert.equal(formatCompetitorListHtml([], 8, (v) => v), '');
  });
});
