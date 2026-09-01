/**
 * Sites / globe performance helpers — zoom LOD for clustering, paint batch
 * sizing, and the DISPLAY "Fast" preset flag (bloom off, gentler Sites paint).
 */

/** @typedef {{ maxHeight: number, pixelRange: number, minimumClusterSize: number }} SitesClusterLodBand */

/**
 * Camera-height bands (metres above ellipsoid). Higher → fewer on-screen
 * markers (clusters only / aggressive merge) so SA overview stays light.
 * @type {readonly SitesClusterLodBand[]}
 */
export const SITES_CLUSTER_LOD_BANDS = Object.freeze([
  Object.freeze({ maxHeight: 6_000, pixelRange: 14, minimumClusterSize: 3 }),
  Object.freeze({ maxHeight: 25_000, pixelRange: 22, minimumClusterSize: 4 }),
  Object.freeze({ maxHeight: 80_000, pixelRange: 42, minimumClusterSize: 8 }),
  Object.freeze({ maxHeight: 250_000, pixelRange: 78, minimumClusterSize: 18 }),
  Object.freeze({ maxHeight: Number.POSITIVE_INFINITY, pixelRange: 120, minimumClusterSize: 32 }),
]);

/** Default entity paint batch (post first-paint / DEMO stream). */
export const SITES_PAINT_BATCH_DEFAULT = 48;
/** First-paint batch when streaming a large import (not the Cape Town preview). */
export const SITES_FIRST_PAINT_CAP_DEFAULT = 350;
/** Gentler stream batch under Fast preset. */
export const SITES_PAINT_BATCH_FAST = 24;
/** Extra idle yield between stream batches (ms). */
export const SITES_PAINT_YIELD_MS_DEFAULT = 40;
export const SITES_PAINT_YIELD_MS_FAST = 64;

/** @type {boolean} */
let _fastPreset = false;
/** @type {Set<(enabled:boolean)=>void>} */
const _listeners = new Set();

/**
 * @param {number} heightM Camera height above ellipsoid (m).
 * @param {{fast?:boolean}} [opts]
 * @returns {{pixelRange:number, minimumClusterSize:number, bandIndex:number}}
 */
export function clusterParamsForHeight(heightM, { fast = isPerformanceFastPreset() } = {}) {
  const h = Number.isFinite(heightM) && heightM > 0 ? heightM : Number.POSITIVE_INFINITY;
  let bandIndex = SITES_CLUSTER_LOD_BANDS.length - 1;
  let band = SITES_CLUSTER_LOD_BANDS[bandIndex];
  for (let i = 0; i < SITES_CLUSTER_LOD_BANDS.length; i++) {
    if (h <= SITES_CLUSTER_LOD_BANDS[i].maxHeight) {
      band = SITES_CLUSTER_LOD_BANDS[i];
      bandIndex = i;
      break;
    }
  }
  let pixelRange = band.pixelRange;
  let minimumClusterSize = band.minimumClusterSize;
  if (fast) {
    pixelRange = Math.min(160, Math.round(pixelRange * 1.4));
    minimumClusterSize = Math.min(48, Math.max(minimumClusterSize + 4, Math.round(minimumClusterSize * 1.5)));
  }
  return { pixelRange, minimumClusterSize, bandIndex };
}

/**
 * @param {{streaming?:boolean, fast?:boolean}} [opts]
 * @returns {number}
 */
export function sitesPaintBatchSize({ streaming = false, fast = isPerformanceFastPreset() } = {}) {
  if (fast) return SITES_PAINT_BATCH_FAST;
  if (streaming) return SITES_PAINT_BATCH_DEFAULT;
  return SITES_PAINT_BATCH_DEFAULT;
}

/**
 * @param {{streaming?:boolean, fast?:boolean}} [opts]
 * @returns {number}
 */
export function sitesPaintYieldMs({ streaming = false, fast = isPerformanceFastPreset() } = {}) {
  if (fast) return SITES_PAINT_YIELD_MS_FAST;
  if (streaming) return SITES_PAINT_YIELD_MS_DEFAULT;
  return 32;
}

export function isPerformanceFastPreset() {
  return _fastPreset;
}

/**
 * @param {boolean} enabled
 * @returns {boolean} New state
 */
export function setPerformanceFastPreset(enabled) {
  const next = Boolean(enabled);
  if (next === _fastPreset) return _fastPreset;
  _fastPreset = next;
  for (const listener of _listeners) {
    try { listener(_fastPreset); } catch { /* ignore */ }
  }
  return _fastPreset;
}

/**
 * @param {(enabled:boolean)=>void} listener
 * @returns {() => void} unsubscribe
 */
export function onPerformanceFastChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Test seam */
export function _resetPerformanceFastForTest() {
  _fastPreset = false;
  _listeners.clear();
}

/**
 * Approx haversine metres between two lon/lat pairs.
 * @param {number} lon1 @param {number} lat1 @param {number} lon2 @param {number} lat2
 */
export function approxDistanceM(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Sort features so near-camera / near-focus points paint first (offscreen last).
 * @param {object[]} features
 * @param {number} lon
 * @param {number} lat
 * @returns {object[]}
 */
export function prioritizeFeaturesNear(features, lon, lat) {
  const list = Array.isArray(features) ? features.slice() : [];
  if (![lon, lat].every(Number.isFinite) || list.length < 2) return list;
  const scored = list.map((feature, index) => {
    const c = primaryCoord(feature);
    const dist = c
      ? approxDistanceM(lon, lat, c[0], c[1])
      : Number.POSITIVE_INFINITY;
    return { feature, dist, index };
  });
  scored.sort((a, b) => (a.dist - b.dist) || (a.index - b.index));
  return scored.map((row) => row.feature);
}

function primaryCoord(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  if (g.type === 'Point' && Array.isArray(g.coordinates)) return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates?.[0]?.[0];
  if (g.type === 'LineString') return g.coordinates?.[0];
  if (g.type === 'MultiPoint') return g.coordinates?.[0];
  if (g.type === 'MultiPolygon') return g.coordinates?.[0]?.[0]?.[0];
  return null;
}
