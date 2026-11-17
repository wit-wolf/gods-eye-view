/**
 * Shared bbox fetch for a zoning provider (proxy first, then direct FeatureServer).
 */
import {
  buildZoningQueryUrl,
  matchZoningCollection,
} from './zoningProviders.js';

async function parseJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {import('./zoningProviders.js').ZoningProvider} provider
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function loadZoningProviderBbox(provider, latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: provider.municipality,
      example: false,
      source: provider.id,
      message: `Pin has no coordinates — cannot query ${provider.municipality} zoning.`,
    };
  }

  const corsMessage = `${provider.municipality} zoning FeatureServer blocked (CORS/network). `
    + 'Drop a GeoJSON extract at public/sites/zoning.geojson to enable.';

  // 1) Same-origin Vite proxy (dev/preview).
  try {
    const proxyUrl = `${provider.proxyUrl}?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`;
    const res = await fetch(proxyUrl, { signal, cache: 'no-cache' });
    if (res.ok) {
      const data = await parseJsonSafe(res);
      if (data) return matchZoningCollection(provider, data, longitude, latitude);
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }

  // 2) Direct FeatureServer — may hit CORS outside allow-listed origins.
  try {
    const res = await fetch(buildZoningQueryUrl(provider, latitude, longitude), {
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
        municipality: provider.municipality,
        example: false,
        source: provider.id,
        message: corsMessage,
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
        municipality: provider.municipality,
        example: false,
        source: provider.id,
        message: corsMessage,
      };
    }
    return matchZoningCollection(provider, data, longitude, latitude);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'unavailable',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: provider.municipality,
      example: false,
      source: provider.id,
      message: corsMessage,
    };
  }
}
