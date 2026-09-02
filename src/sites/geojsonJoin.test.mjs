/**
 * Unit tests for GeoJSON point-in-polygon join helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetGeoJsonCollectionCache,
  featureContainsPoint,
  findContainingFeature,
  firstPropString,
  pointInRing,
} from './geojsonJoin.js';

describe('pointInRing / featureContainsPoint', () => {
  const square = [
    [18.0, -34.0],
    [19.0, -34.0],
    [19.0, -33.0],
    [18.0, -33.0],
    [18.0, -34.0],
  ];

  it('detects inside / outside', () => {
    assert.equal(pointInRing(18.5, -33.5, square), true);
    assert.equal(pointInRing(17.0, -33.5, square), false);
  });

  it('finds containing feature', () => {
    const features = [
      {
        type: 'Feature',
        properties: { zone_code: 'A' },
        geometry: { type: 'Polygon', coordinates: [square] },
      },
    ];
    const hit = findContainingFeature(features, 18.5, -33.5);
    assert.equal(hit?.properties?.zone_code, 'A');
    assert.equal(findContainingFeature(features, 10, 10), null);
    assert.equal(
      featureContainsPoint(features[0], 18.5, -33.5),
      true,
    );
  });

  it('firstPropString prefers first non-empty key', () => {
    assert.equal(firstPropString({ a: '', b: 'Yes' }, ['a', 'b']), 'Yes');
    assert.equal(firstPropString({}, ['x']), null);
  });

  it('cache reset is a no-op seam', () => {
    _resetGeoJsonCollectionCache();
  });
});
