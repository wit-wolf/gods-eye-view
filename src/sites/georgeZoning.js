/**
 * George Municipality Integrated Zoning — optional bbox overlay when no local
 * public/sites/zoning.geojson is present. Queries FeatureServer/16 for a small
 * envelope around the open pin (never the full ~54k polygon layer).
 *
 * Prefers same-origin `/api/george-zoning` (Vite proxy). Falls back to a direct
 * FeatureServer fetch; honest fail if CORS/network blocks.
 */
import { findContainingFeature, firstPropString } from './geojsonJoin.js';

export const GEORGE_ZONING_PROXY_URL = '/api/george-zoning';
export const GEORGE_ZONING_FEATURE_SERVER =
  'https://gis.george.gov.za/server/rest/services/Hosted/CITP/FeatureServer/16/query';
export const GEORGE_MUNICIPALITY = 'George Municipality';
export const GEORGE_ZONING_ATTRIBUTION = 'George Municipality Integrated Zoning (CITP)';

/** ~275 m half-width — matches vite proxy envelope. */
export const GEORGE_ZONING_HALF_DEG = 0.0025;
export const GEORGE_ZONING_RESULT_RECORD_COUNT = 25;

const CORS_OR_NETWORK_MESSAGE =
  'George zoning FeatureServer blocked (CORS/network). '
  + 'Drop a GeoJSON extract at public/sites/zoning.geojson to enable.';

/**
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string}
 */
export function buildGeorgeZoningQueryUrl(latitude, longitude) {
  const geometry = JSON.stringify({
    xmin: longitude - GEORGE_ZONING_HALF_DEG,
    ymin: latitude - GEORGE_ZONING_HALF_DEG,
    xmax: longitude + GEORGE_ZONING_HALF_DEG,
    ymax: latitude + GEORGE_ZONING_HALF_DEG,
  });
  const qs = new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'zoning,zoning_code,land_use,town',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: String(GEORGE_ZONING_RESULT_RECORD_COUNT),
  });
  return `${GEORGE_ZONING_FEATURE_SERVER}?${qs}`;
}

/**
 * @param {object} props
 * @returns {{
 *   zoneCode:string|null,
 *   zoneName:string|null,
 *   landUse:string|null,
 *   town:string|null
 * }}
 */
export function readGeorgeZoningProps(props) {
  const p = props && typeof props === 'object' ? props : {};
  return {
    zoneCode: firstPropString(p, ['zoning_code', 'zone_code', 'ZONE_CODE', 'code']),
    zoneName: firstPropString(p, ['zoning', 'zone_name', 'zoneName', 'ZONE_NAME', 'name']),
    landUse: firstPropString(p, ['land_use', 'landUse', 'LAND_USE']),
    town: firstPropString(p, ['town', 'Town', 'TOWN']),
  };
}

/**
 * @param {object} collection FeatureCollection-ish
 * @param {number} longitude
 * @param {number} latitude
 */
function matchFromCollection(collection, longitude, latitude) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  if (!features.length) {
    return {
      status: 'miss',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: GEORGE_MUNICIPALITY,
      example: false,
      source: 'george',
      message: 'George zoning bbox returned no polygons near this pin.',
      sourceNote: GEORGE_ZONING_ATTRIBUTION,
    };
  }
  const hit = findContainingFeature(features, longitude, latitude) || features[0];
  const fields = readGeorgeZoningProps(hit?.properties);
  if (!fields.zoneCode && !fields.zoneName) {
    return {
      status: 'miss',
      ...fields,
      municipality: GEORGE_MUNICIPALITY,
      example: false,
      source: 'george',
      message: 'George zoning feature has no zoning / zoning_code fields.',
      sourceNote: GEORGE_ZONING_ATTRIBUTION,
    };
  }
  return {
    status: 'ok',
    ...fields,
    municipality: GEORGE_MUNICIPALITY,
    example: false,
    source: 'george',
    message: `Matched ${GEORGE_MUNICIPALITY} Integrated Zoning (bbox query — not a national layer).`,
    sourceNote: GEORGE_ZONING_ATTRIBUTION,
  };
}

/**
 * @param {Response} res
 * @returns {Promise<object|null>}
 */
async function parseJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function loadGeorgeZoningBbox(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: GEORGE_MUNICIPALITY,
      example: false,
      source: 'george',
      message: 'Pin has no coordinates — cannot query George zoning.',
    };
  }

  // 1) Same-origin Vite proxy (dev/preview).
  try {
    const proxyUrl = `${GEORGE_ZONING_PROXY_URL}?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`;
    const res = await fetch(proxyUrl, { signal, cache: 'no-cache' });
    if (res.ok) {
      const data = await parseJsonSafe(res);
      if (data) return matchFromCollection(data, longitude, latitude);
    }
    // 404 = static host without middleware → try direct. Other errors still try direct once.
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // fall through to direct FeatureServer
  }

  // 2) Direct FeatureServer — may hit CORS outside allow-listed origins.
  try {
    const res = await fetch(buildGeorgeZoningQueryUrl(latitude, longitude), {
      signal,
      cache: 'no-cache',
      headers: { Accept: 'application/geo+json, application/json' },
    });
    if (!res.ok) {
      return {
        status: 'unavailable',
        zoneCode: null,
        zoneName: null,
        landUse: null,
        town: null,
        municipality: GEORGE_MUNICIPALITY,
        example: false,
        source: 'george',
        message: CORS_OR_NETWORK_MESSAGE,
      };
    }
    const data = await parseJsonSafe(res);
    if (!data) {
      return {
        status: 'unavailable',
        zoneCode: null,
        zoneName: null,
        landUse: null,
        town: null,
        municipality: GEORGE_MUNICIPALITY,
        example: false,
        source: 'george',
        message: CORS_OR_NETWORK_MESSAGE,
      };
    }
    return matchFromCollection(data, longitude, latitude);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'unavailable',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: GEORGE_MUNICIPALITY,
      example: false,
      source: 'george',
      message: CORS_OR_NETWORK_MESSAGE,
    };
  }
}
