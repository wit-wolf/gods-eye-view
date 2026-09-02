/**
 * Point-in-polygon + cached GeoJSON FeatureCollection loaders for Sites /
 * Ancora research joins (zoning, census wards). No invented attributes.
 */

/** @type {Map<string, {at:number, status:string, features:object[], message?:string}>} */
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Ray-casting point-in-ring. ring = [[lon,lat], …].
 * @param {number} lon @param {number} lat @param {number[][]} ring
 */
export function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.[0]);
    const yi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const yj = Number(ring[j]?.[1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersect = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * @param {object} feature GeoJSON Feature
 * @param {number} lon @param {number} lat
 */
export function featureContainsPoint(feature, lon, lat) {
  if (![lon, lat].every(Number.isFinite) || !feature?.geometry) return false;
  const g = feature.geometry;
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    const rings = g.coordinates;
    if (!pointInRing(lon, lat, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(lon, lat, rings[i])) return false;
    }
    return true;
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    return g.coordinates.some((poly) => featureContainsPoint(
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: {} },
      lon,
      lat,
    ));
  }
  return false;
}

/**
 * First containing polygon/multipolygon (order preserved).
 * @param {object[]} features
 * @param {number} lon @param {number} lat
 */
export function findContainingFeature(features, lon, lat) {
  const list = Array.isArray(features) ? features : [];
  for (const feature of list) {
    if (featureContainsPoint(feature, lon, lat)) return feature;
  }
  return null;
}

/**
 * Fetch a FeatureCollection from a same-origin URL (e.g. /sites/zoning.geojson).
 * Missing → status missing; empty features → empty; parse errors → error.
 * @param {string} url
 * @param {{signal?:AbortSignal, force?:boolean}} [opts]
 * @returns {Promise<{
 *   status:'ok'|'empty'|'missing'|'error',
 *   features:object[],
 *   message?:string,
 *   url:string
 * }>}
 */
export async function loadGeoJsonCollection(url, { signal, force = false } = {}) {
  const key = String(url || '');
  if (!key) {
    return { status: 'missing', features: [], message: 'No GeoJSON URL configured.', url: key };
  }
  const hit = _cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return {
      status: hit.status,
      features: hit.features,
      message: hit.message,
      url: key,
    };
  }

  let res;
  try {
    res = await fetch(key, { signal, cache: 'no-cache' });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const out = {
      status: 'error',
      features: [],
      message: 'Zoning/census GeoJSON request failed.',
      url: key,
    };
    _cache.set(key, { at: Date.now(), ...out });
    return out;
  }

  if (res.status === 404) {
    const out = {
      status: 'missing',
      features: [],
      message: 'No GeoJSON file at this path.',
      url: key,
    };
    _cache.set(key, { at: Date.now(), ...out });
    return out;
  }
  if (!res.ok) {
    const out = {
      status: 'error',
      features: [],
      message: `GeoJSON HTTP ${res.status}`,
      url: key,
    };
    _cache.set(key, { at: Date.now(), ...out });
    return out;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const out = {
      status: 'error',
      features: [],
      message: 'GeoJSON could not be parsed.',
      url: key,
    };
    _cache.set(key, { at: Date.now(), ...out });
    return out;
  }

  const features = Array.isArray(data?.features) ? data.features.filter(Boolean) : [];
  if (!features.length) {
    const out = {
      status: 'empty',
      features: [],
      message: 'GeoJSON file has no features.',
      url: key,
    };
    _cache.set(key, { at: Date.now(), ...out });
    return out;
  }

  const out = { status: 'ok', features, url: key };
  _cache.set(key, { at: Date.now(), ...out });
  return out;
}

/** Test seam */
export function _resetGeoJsonCollectionCache() {
  _cache.clear();
}

/**
 * Pick first non-empty string from property keys.
 * @param {object} props
 * @param {string[]} keys
 */
export function firstPropString(props, keys) {
  const p = props && typeof props === 'object' ? props : {};
  for (const key of keys) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}
