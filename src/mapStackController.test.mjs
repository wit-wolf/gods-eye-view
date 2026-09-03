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

test('globe basemap swaps replace imagery at index 0 and never touch groundPrimitives', async () => {
  // Source contract: MapStackController must only manage its own imagery layer
  // at index 0. Traffic heat-lines live in scene.groundPrimitives — burying or
  // clearing them on Satellite ↔ Streets would hide live TomTom overlay.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');
  assert.match(src, /imageryLayers\.add\(this\._imageryLayer,\s*0\)/);
  assert.match(src, /_removeImageryLayer\(\)/);
  assert.doesNotMatch(
    src,
    /groundPrimitives/,
    'map stack must not add/remove groundPrimitives (traffic overlay lives there)',
  );

  const imageryOps = [];
  const layers = [];
  const imageryLayers = {
    add(layer, index) {
      imageryOps.push({ op: 'add', index, layer });
      if (index == null) layers.push(layer);
      else layers.splice(index, 0, layer);
    },
    remove(layer) {
      imageryOps.push({ op: 'remove', layer });
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      return true;
    },
  };
  const groundOps = [];
  const groundPrimitives = {
    add(p) { groundOps.push(['add', p]); return p; },
    remove(p) { groundOps.push(['remove', p]); return true; },
  };
  const trafficOverlay = { id: 'traffic-heat' };
  groundPrimitives.add(trafficOverlay);

  const viewer = {
    scene: { globe: { show: true }, setTerrain() {}, groundPrimitives },
    imageryLayers,
    terrainProvider: null,
  };
  const controller = new MapStackController(viewer, {
    googleApiKey: 'test-key',
    googleTileset: { show: true },
    cesiumToken: '',
    initialStack: 'osm',
  });
  controller._reearthTerrainProvider = { id: 'flat-terrain' };
  controller._terrainMode = 'keyless';

  // Simulate managed basemap swaps the same way _activateGlobeStack commits:
  // remove prior managed layer, add the next at index 0. (Full ImageryLayer
  // construction needs a real Cesium provider; this exercises the order
  // contract without inventing keys or hitting Google.)
  const satLayer = { id: 'google-satellite-layer' };
  const osmLayer = { id: 'osm-layer' };
  controller._imageryLayer = satLayer;
  imageryLayers.add(satLayer, 0);
  controller._removeImageryLayer();
  controller._imageryLayer = osmLayer;
  imageryLayers.add(osmLayer, 0);
  assert.deepEqual(
    imageryOps.filter((o) => o.op === 'add').map((o) => o.index),
    [0, 0],
  );
  assert.equal(layers.length, 1);
  assert.equal(layers[0], osmLayer);
  assert.equal(controller._imageryLayer, osmLayer);

  // Photoreal: hide globe, show tileset — still must not strip groundPrimitives.
  await controller._activatePhotoreal(controller.getSwitchGeneration());
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(controller.googleTileset.show, true);
  assert.equal(controller._imageryLayer, null);
  assert.deepEqual(groundOps, [['add', trafficOverlay]]);
  assert.equal(groundOps.filter((o) => o[0] === 'remove').length, 0);

  // Classification mapping: Satellite/Streets → TERRAIN; photoreal → 3D tiles.
  // (trafficOverlayClassification owns the live values; this pins stack ids.)
  const { trafficClassificationTypeForStack } = await import('./data/trafficOverlayClassification.js');
  const Cesium = await import('cesium');
  assert.equal(
    trafficClassificationTypeForStack('google-satellite'),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(
    trafficClassificationTypeForStack('osm'),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(
    trafficClassificationTypeForStack('google-hybrid'),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(
    trafficClassificationTypeForStack('photoreal'),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
});
