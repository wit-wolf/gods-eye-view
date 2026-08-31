/**
 * Client helpers for Volee location search.
 *
 * Calls Google Places API (New) **from the browser** with the same
 * `GOOGLE_MAPS_API_KEY` already used for Photorealistic 3D Tiles. That key is
 * HTTP-referrer restricted (localhost:4173); Vite Node proxies cannot use it
 * (empty referrer → REQUEST_DENIED / blocked). Geocoding REST also rejects
 * referrer-restricted keys entirely — so search uses Places Autocomplete,
 * Place Details, and Text Search only.
 */

import { PRODUCT_PROFILE } from '../productProfile.js';

const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/** @returns {string} ISO 3166-1 alpha-2 country for Places `regionCode`. */
export function searchCountryCode(profile = PRODUCT_PROFILE) {
  return String(profile?.search?.countryCode || 'ZA').toUpperCase();
}

/** @returns {string[]} Lowercase region codes for Places Autocomplete. */
export function searchRegionCodes(profile = PRODUCT_PROFILE) {
  const codes = profile?.search?.regionCodes;
  if (Array.isArray(codes) && codes.length) return codes.map((c) => String(c).toLowerCase());
  return [searchCountryCode(profile).toLowerCase()];
}

/** Resolve the client-exposed Maps key (tiles + Places). */
export function clientMapsApiKey() {
  const fromWindow = typeof globalThis !== 'undefined'
    && globalThis.window
    && globalThis.window.__GOOGLE_MAPS_API_KEY__;
  let fromEnv = '';
  try {
    // Vite injects import.meta.env; plain Node unit tests may have no env object.
    fromEnv = import.meta.env?.GOOGLE_MAPS_API_KEY || '';
  } catch {
    fromEnv = '';
  }
  return String(fromWindow || fromEnv || '').trim();
}

function missingKeyError(detail = 'GOOGLE_MAPS_API_KEY is not set') {
  const err = new Error(detail);
  err.code = 'KEY_MISSING';
  err.keyMissing = true;
  return err;
}

function placesDeniedError(message, status = 'REQUEST_DENIED') {
  const err = new Error(message || 'Google Places request denied');
  err.code = status;
  return err;
}

/**
 * @param {Response} response
 * @param {object} data
 */
function assertPlacesOk(response, data) {
  if (response.ok) return;
  const message = data?.error?.message || data?.error || `Places request failed (${response.status})`;
  if (/API key/i.test(message) && /not (set|valid|found)|missing|invalid/i.test(message)) {
    throw missingKeyError(message);
  }
  if (response.status === 403 || /denied|blocked|referer/i.test(message)) {
    throw placesDeniedError(message);
  }
  const err = new Error(message);
  err.code = 'HTTP_ERROR';
  throw err;
}

/**
 * Map a Places (New) place resource into the geocode-shaped object
 * `searchAndFlyTo` already frames.
 * @param {object} place
 */
export function placeResourceToGeocodeResult(place) {
  if (!place) return null;
  const lat = place.location?.latitude ?? place.latitude;
  const lng = place.location?.longitude ?? place.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const vp = place.viewport;
  const viewport = (
    Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
    && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
  ) ? {
    southwest: { lat: vp.low.latitude, lng: vp.low.longitude },
    northeast: { lat: vp.high.latitude, lng: vp.high.longitude },
  } : null;
  return {
    formatted_address: place.formattedAddress || place.address || place.displayName?.text || place.name || null,
    types: Array.isArray(place.types) ? place.types : [],
    geometry: {
      location: { lat, lng },
      viewport,
      bounds: viewport,
    },
  };
}

/**
 * Resolve a free-text query via Places Text Search (New), region-restricted.
 * Returns a geocode-compatible payload for camera framing.
 *
 * @param {string} query
 * @param {{ countryCode?: string|null, signal?: AbortSignal }} [options]
 */
export async function geocodeSearch(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) return { status: 'ZERO_RESULTS', results: [], error: null };

  const apiKey = clientMapsApiKey();
  if (!apiKey) throw missingKeyError();

  const country = options.countryCode === null
    ? null
    : (options.countryCode || searchCountryCode());

  const response = await fetch(PLACES_SEARCH_TEXT_URL, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.viewport',
        'places.types',
        'places.primaryType',
      ].join(','),
    },
    body: JSON.stringify({
      textQuery: q,
      maxResultCount: 5,
      ...(country ? { regionCode: country } : {}),
    }),
  });
  const data = await response.json().catch(() => ({}));
  assertPlacesOk(response, data);

  const results = (Array.isArray(data.places) ? data.places : [])
    .map(placeResourceToGeocodeResult)
    .filter(Boolean);

  return {
    status: results.length ? 'OK' : 'ZERO_RESULTS',
    results,
    error: null,
  };
}

/**
 * Places Autocomplete (New) suggestions, region-restricted.
 * @param {string} input
 * @param {{ regionCodes?: string[], signal?: AbortSignal }} [options]
 */
export async function autocompleteSearch(input, options = {}) {
  const q = String(input || '').trim();
  if (q.length < 2) return [];

  const apiKey = clientMapsApiKey();
  if (!apiKey) throw missingKeyError();

  const regions = options.regionCodes || searchRegionCodes();
  const response = await fetch(PLACES_AUTOCOMPLETE_URL, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'suggestions.placePrediction.placeId',
        'suggestions.placePrediction.text',
        'suggestions.placePrediction.structuredFormat',
        'suggestions.placePrediction.types',
      ].join(','),
    },
    body: JSON.stringify({
      input: q,
      includedRegionCodes: regions.length ? regions : ['za'],
      includeQueryPredictions: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  assertPlacesOk(response, data);

  return Array.isArray(data.suggestions)
    ? data.suggestions
      .map((entry) => {
        const prediction = entry?.placePrediction;
        if (!prediction?.placeId) return null;
        const label = prediction.text?.text
          || [prediction.structuredFormat?.mainText?.text, prediction.structuredFormat?.secondaryText?.text]
            .filter(Boolean)
            .join(', ');
        if (!label) return null;
        return {
          placeId: prediction.placeId,
          label,
          mainText: prediction.structuredFormat?.mainText?.text || label,
          secondaryText: prediction.structuredFormat?.secondaryText?.text || '',
          types: Array.isArray(prediction.types) ? prediction.types.slice(0, 8) : [],
        };
      })
      .filter(Boolean)
      .slice(0, 8)
    : [];
}

/**
 * Resolve a Places place id to lat/lng for camera framing.
 * @param {string} placeId
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function placeDetailsSearch(placeId, options = {}) {
  const id = String(placeId || '').trim();
  if (!id) return null;

  const apiKey = clientMapsApiKey();
  if (!apiKey) throw missingKeyError();

  const resourceName = id.startsWith('places/') ? id : `places/${id}`;
  const response = await fetch(`https://places.googleapis.com/v1/${resourceName}`, {
    method: 'GET',
    signal: options.signal,
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'id',
        'displayName',
        'formattedAddress',
        'location',
        'viewport',
        'types',
        'primaryType',
      ].join(','),
    },
  });
  const data = await response.json().catch(() => ({}));
  assertPlacesOk(response, data);

  const latitude = data.location?.latitude ?? null;
  const longitude = data.location?.longitude ?? null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const vp = data.viewport;
  const viewport = (
    Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
    && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
  ) ? {
    low: { latitude: vp.low.latitude, longitude: vp.low.longitude },
    high: { latitude: vp.high.latitude, longitude: vp.high.longitude },
  } : null;

  return {
    id: data.id || id,
    name: data.displayName?.text || null,
    address: data.formattedAddress || null,
    latitude,
    longitude,
    viewport,
    types: Array.isArray(data.types) ? data.types.slice(0, 8) : [],
    primaryType: data.primaryType || null,
  };
}

/**
 * View-biased Text Search for near-view recovery (annotation / search twin).
 * Browser Places call — same referrer-restricted key as tiles.
 *
 * @returns {Promise<null | {
 *   lat: number, lon: number, label: string|null, distanceM: number,
 *   types: string[],
 *   viewport: {low:{latitude:number,longitude:number},high:{latitude:number,longitude:number}}|null
 * }>}
 */
export async function placesTextSearchNear(query, centerLat, centerLon, radiusM, signal) {
  const q = String(query || '').trim();
  if (!q || !Number.isFinite(centerLat) || !Number.isFinite(centerLon)) return null;

  const apiKey = clientMapsApiKey();
  if (!apiKey) return null;

  const country = searchCountryCode();
  const response = await fetch(PLACES_SEARCH_TEXT_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.viewport',
        'places.types',
      ].join(','),
    },
    body: JSON.stringify({
      textQuery: q,
      maxResultCount: 5,
      ...(country ? { regionCode: country } : {}),
      locationBias: {
        circle: {
          center: { latitude: centerLat, longitude: centerLon },
          radius: Math.max(50, Math.min(50000, Number(radiusM) || 4000)),
        },
      },
    }),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const hit = Array.isArray(data.places)
    ? data.places.find((p) => Number.isFinite(p?.location?.latitude) && Number.isFinite(p?.location?.longitude))
    : null;
  if (!hit) return null;

  const lat = hit.location.latitude;
  const lon = hit.location.longitude;
  const vp = hit.viewport;
  const viewport = (
    Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
    && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
  ) ? {
    low: { latitude: vp.low.latitude, longitude: vp.low.longitude },
    high: { latitude: vp.high.latitude, longitude: vp.high.longitude },
  } : null;

  return {
    lat,
    lon,
    label: hit.displayName?.text || hit.formattedAddress || null,
    distanceM: approximateDistanceM(centerLat, centerLon, lat, lon),
    types: Array.isArray(hit.types) ? hit.types.slice(0, 8) : [],
    viewport,
  };
}

function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  const dLat = (latB - latA) * latitudeScale;
  const dLon = (lonB - lonA) * longitudeScale;
  return Math.hypot(dLat, dLon);
}
