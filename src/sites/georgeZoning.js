/**
 * George Municipality Integrated Zoning — thin adapter over the shared
 * zoning provider registry (`zoningProviders.js`). Kept so existing imports
 * and the `/api/george-zoning` proxy path continue to work.
 */
import {
  GEORGE_ZONING_PROVIDER,
  ZONING_HALF_DEG,
  ZONING_RESULT_RECORD_COUNT,
  buildZoningQueryUrl,
  matchZoningCollection,
  readZoningProps,
  selectZoningProvider,
} from './zoningProviders.js';
import { loadZoningProviderBbox } from './zoningQuery.js';

export const GEORGE_ZONING_PROXY_URL = GEORGE_ZONING_PROVIDER.proxyUrl;
export const GEORGE_ZONING_FEATURE_SERVER = GEORGE_ZONING_PROVIDER.featureServer;
export const GEORGE_MUNICIPALITY = GEORGE_ZONING_PROVIDER.municipality;
export const GEORGE_ZONING_ATTRIBUTION = GEORGE_ZONING_PROVIDER.attribution;
export const GEORGE_ZONING_HALF_DEG = ZONING_HALF_DEG;
export const GEORGE_ZONING_RESULT_RECORD_COUNT = ZONING_RESULT_RECORD_COUNT;

/**
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string}
 */
export function buildGeorgeZoningQueryUrl(latitude, longitude) {
  return buildZoningQueryUrl(GEORGE_ZONING_PROVIDER, latitude, longitude);
}

/**
 * @param {object} props
 */
export function readGeorgeZoningProps(props) {
  return readZoningProps(GEORGE_ZONING_PROVIDER, props);
}

/**
 * Query George zoning only when the pin falls inside George Municipality's
 * registered extent. Outside that bbox callers should use the registry
 * (`selectZoningProvider` / `loadSiteZoning`) instead of this helper.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function loadGeorgeZoningBbox(latitude, longitude, { signal } = {}) {
  const provider = selectZoningProvider(latitude, longitude);
  if (!provider || provider.id !== 'george') {
    return {
      status: 'miss',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: null,
      example: false,
      source: 'none',
      message: 'No zoning data for this area yet',
    };
  }
  return loadZoningProviderBbox(provider, latitude, longitude, { signal });
}

/** @deprecated Prefer matchZoningCollection — kept for tests. */
export function matchGeorgeCollection(collection, longitude, latitude) {
  return matchZoningCollection(GEORGE_ZONING_PROVIDER, collection, longitude, latitude);
}
