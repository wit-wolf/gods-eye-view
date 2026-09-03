// src/data/trafficOverlayClassification.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../mapStackController.js';
import {
  TRAFFIC_GLOBE_STACK_IDS,
  trafficClassificationTypeForScene,
  trafficClassificationTypeForStack,
} from './trafficOverlayClassification.js';
import trafficLayer from './traffic.js';

test('traffic heat-lines classify against exactly the active surface on every stack', () => {
  assert.equal(
    trafficClassificationTypeForStack('photoreal'),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  for (const stackId of TRAFFIC_GLOBE_STACK_IDS) {
    assert.equal(
      trafficClassificationTypeForStack(stackId),
      Cesium.ClassificationType.TERRAIN,
      `${stackId} must drape traffic onto the globe/terrain when 3D tiles are off`,
    );
  }
  // Unknown → BOTH (safe on every surface).
  assert.equal(trafficClassificationTypeForStack('some-future-stack'), Cesium.ClassificationType.BOTH);
  assert.equal(trafficClassificationTypeForStack(undefined), Cesium.ClassificationType.BOTH);
  assert.equal(trafficClassificationTypeForStack(null), Cesium.ClassificationType.BOTH);

  // Every shipped MAP_STACKS id must have an explicit mapping — omission
  // would silently fall back to BOTH (visible, but doubles GPU cost).
  for (const stack of MAP_STACKS) {
    assert.notEqual(
      trafficClassificationTypeForStack(stack.id),
      Cesium.ClassificationType.BOTH,
      `MAP_STACKS id '${stack.id}' has no traffic classification mapping`,
    );
  }

  // Boot silent setStack: photoreal ⇔ globe hidden.
  assert.equal(
    trafficClassificationTypeForScene({ globe: { show: false } }),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  assert.equal(
    trafficClassificationTypeForScene({ globe: { show: true } }),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(trafficClassificationTypeForScene(null), Cesium.ClassificationType.BOTH);
});

test('live traffic defaults to a road overlay (heatlines), not density-only dots', () => {
  assert.equal(trafficLayer.getParams().jamViz, 'both');
  assert.ok(
    trafficLayer.getParams().jamViz === 'both' || trafficLayer.getParams().jamViz === 'heatline',
    'property default must paint congestion-colored roads, not dots alone',
  );
});

test('keyless traffic stays honest as simulated; live presentation never pretends without a key', () => {
  const stats = trafficLayer.getStats();
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.jamViz, 'both');
  assert.match(stats.loadingLabel, /^SIMULATED/);
  assert.ok(!/\bLIVE\b/.test(stats.loadingLabel));
  assert.equal(trafficLayer.name, 'Traffic (simulated)');
});

test('traffic.js heat-lines no longer hardcode CESIUM_3D_TILE-only classification', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./traffic.js', import.meta.url), 'utf8');
  // Must resolve classification (stack/scene) — not bake 3D-tile-only.
  assert.match(src, /resolveHeatClassification|trafficClassificationTypeForStack/);
  assert.match(src, /classificationType:\s*classification/);
  // The old photoreal-only drape must not be the only path.
  assert.ok(
    !/classificationType:\s*Cesium\.ClassificationType\.CESIUM_3D_TILE/.test(src),
    'heat-line create must not hardcode CESIUM_3D_TILE (invisible on Satellite globe)',
  );
  assert.match(src, /gev:map-stack-changed/);
  assert.match(src, /_heatFreePrim/);
});
