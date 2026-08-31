/**
 * Client helpers for Volee location search — Google Geocoding + Places (New)
 * via same-origin Vite proxies (key stays server-side on the request path).
 */

import { PRODUCT_PROFILE } from '../productProfile.js';

/** @returns {string} ISO 3166-1 alpha-2 country for Geocoding `components=`. */
export function searchCountryCode(profile = PRODUCT_PROFILE) {
  return String(profile?.search?.countryCode || 'ZA').toUpperCase();
}

/** @returns {string[]} Lowercase region codes for Places Autocomplete. */
export function searchRegionCodes(profile = PRODUCT_PROFILE) {
  const codes = profile?.search?.regionCodes;
  if (Array.isArray(codes) && codes.length) return codes.map((c) => String(c).toLowerCase());
  return [searchCountryCode(profile).toLowerCase()];
}

/**
 * Forward-geocode a query, restricted to the product country when set.
 * @param {string} query
 * @param {{ countryCode?: string|null, bounds?: string|null, signal?: AbortSignal }} [options]
 * @returns {Promise<{
 *   status: string,
 *   results: Array<object>,
 *   error?: string|null,
 *   keyMissing?: boolean,
 * }>}
 */
export async function geocodeSearch(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) return { status: 'ZERO_RESULTS', results: [], error: null };

  const params = new URLSearchParams({ q });
  const country = options.countryCode === null
    ? null
    : (options.countryCode || searchCountryCode());
  if (country) params.set('country', country);
  if (options.bounds) params.set('bounds', options.bounds);

  const response = await fetch(`/api/google/geocode?${params}`, {
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 503) {
    const error = data.error || 'GOOGLE_MAPS_API_KEY is not set';
    const err = new Error(error);
    err.code = 'KEY_MISSING';
    err.keyMissing = true;
    throw err;
  }
  if (!response.ok) {
    const error = data.error || `Geocoding failed (${response.status})`;
    const err = new Error(error);
    err.code = data.status || 'HTTP_ERROR';
    throw err;
  }
  return {
    status: data.status || 'UNKNOWN',
    results: Array.isArray(data.results) ? data.results : [],
    error: data.error || null,
  };
}

/**
 * Places Autocomplete (New) suggestions, region-restricted.
 * @param {string} input
 * @param {{ regionCodes?: string[], signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ placeId: string, label: string, mainText: string, secondaryText: string }>>}
 */
export async function autocompleteSearch(input, options = {}) {
  const q = String(input || '').trim();
  if (q.length < 2) return [];

  const params = new URLSearchParams({ q });
  const regions = options.regionCodes || searchRegionCodes();
  if (regions.length) params.set('region', regions.join(','));

  const response = await fetch(`/api/google/autocomplete?${params}`, {
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 503) {
    const err = new Error(data.error || 'GOOGLE_MAPS_API_KEY is not set');
    err.code = 'KEY_MISSING';
    err.keyMissing = true;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(data.error || `Autocomplete failed (${response.status})`);
    err.code = 'HTTP_ERROR';
    throw err;
  }
  return Array.isArray(data.suggestions) ? data.suggestions : [];
}

/**
 * Resolve a Places place id to a geocode-shaped result for camera framing.
 * @param {string} placeId
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function placeDetailsSearch(placeId, options = {}) {
  const id = String(placeId || '').trim();
  if (!id) return null;
  const params = new URLSearchParams({ id });
  const response = await fetch(`/api/google/place?${params}`, {
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 503) {
    const err = new Error(data.error || 'GOOGLE_MAPS_API_KEY is not set');
    err.code = 'KEY_MISSING';
    err.keyMissing = true;
    throw err;
  }
  if (!response.ok || !data.place) return null;
  return data.place;
}
