import * as Cesium from 'cesium';

/**
 * @file Ground-line classification for Street Traffic heat-lines.
 *
 * After the property Map style widget, cold start is Google 2D satellite on the
 * shown Cesium globe with Photorealistic 3D tiles OFF. Heat-lines that classify
 * only against `CESIUM_3D_TILE` are invisible on that default. Photoreal hides
 * the globe, so terrain-only classification fails there. Match the active
 * surface (same contract as submarine-cable ground lines).
 *
 * @module data/trafficOverlayClassification
 */

/**
 * `MAP_STACKS` ids that render imagery on the SHOWN Cesium globe.
 * Explicit allowlist — unknown ids must fall back to BOTH so a future stack
 * never silently vanishes on one surface.
 */
export const TRAFFIC_GLOBE_STACK_IDS = Object.freeze(
  new Set(['bing-aerial', 'bing-labels', 'osm', 'google-satellite', 'google-hybrid']),
);

/**
 * Ground-line classification for one map stack.
 * @param {string|null|undefined} activeId MapStackController stack id.
 * @returns {Cesium.ClassificationType}
 */
export function trafficClassificationTypeForStack(activeId) {
  if (activeId === 'photoreal') return Cesium.ClassificationType.CESIUM_3D_TILE;
  if (TRAFFIC_GLOBE_STACK_IDS.has(activeId)) return Cesium.ClassificationType.TERRAIN;
  return Cesium.ClassificationType.BOTH;
}

/**
 * Derive classification from live scene state when no stack event has fired
 * yet (boot `setStack(..., { silent: true })`). Photoreal ⇔ globe hidden.
 * @param {Cesium.Scene|null|undefined} scene
 * @returns {Cesium.ClassificationType}
 */
export function trafficClassificationTypeForScene(scene) {
  if (!scene?.globe) return Cesium.ClassificationType.BOTH;
  return scene.globe.show === false
    ? Cesium.ClassificationType.CESIUM_3D_TILE
    : Cesium.ClassificationType.TERRAIN;
}
