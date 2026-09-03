import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAP_STACK_ID,
  FALLBACK_MAP_STACK_ID,
  MAP_STACKS,
  MapStackController,
} from './mapStackController.js';

test('MAP_STACKS includes Google 2D satellite/hybrid, Streets, 3D, and Bing', () => {
  assert.equal(DEFAULT_MAP_STACK_ID, 'google-satellite');
  assert.equal(FALLBACK_MAP_STACK_ID, 'osm');
  const ids = MAP_STACKS.map((s) => s.id);
  assert.deepEqual(ids, [
    'google-satellite',
    'osm',
    'google-hybrid',
    'photoreal',
    'bing-aerial',
    'bing-labels',
  ]);
  assert.equal(MAP_STACKS.find((s) => s.id === 'osm').label, 'Streets');
  assert.equal(MAP_STACKS.find((s) => s.id === 'photoreal').label, '3D buildings');
  assert.equal(MAP_STACKS.find((s) => s.id === 'google-satellite').kind, 'google2d');
  assert.deepEqual(
    [...MAP_STACKS.find((s) => s.id === 'google-hybrid').layerTypes],
    ['layerRoadmap'],
  );
});

test('resolveDefaultStackId prefers Satellite when Google key present, else Streets', () => {
  const viewer = { scene: { globe: { show: true }, setTerrain() {} }, imageryLayers: { add() {}, remove() {} } };
  const withKey = new MapStackController(viewer, {
    googleApiKey: 'test-key',
    googleTileset: { show: false },
    cesiumToken: '',
  });
  assert.equal(withKey.resolveDefaultStackId(), 'google-satellite');
  assert.equal(withKey.isStackAvailable('google-satellite'), true);
  assert.equal(withKey.isStackAvailable('bing-aerial'), false);
  assert.match(withKey.getStacks().find((s) => s.id === 'bing-aerial').unavailableReason, /ion/i);

  const noKey = new MapStackController(viewer, {
    googleApiKey: '',
    googleTileset: null,
    cesiumToken: '',
  });
  // Without a Google key, Google2D stacks are unavailable; Streets remains.
  assert.equal(noKey.isStackAvailable('google-satellite'), false);
  assert.equal(noKey.resolveDefaultStackId(), 'osm');
  assert.equal(noKey.isStackAvailable('photoreal'), false);
});
