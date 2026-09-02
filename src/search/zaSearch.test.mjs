import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PRODUCT_PROFILE } from '../productProfile.js';
import {
  clientMapsApiKey,
  geocodeSearch,
  placeResourceToGeocodeResult,
  searchCountryCode,
  searchRegionCodes,
} from './googlePlacesSearch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('Volee search profile hard-biases to South Africa', () => {
  assert.equal(PRODUCT_PROFILE.search.countryCode, 'ZA');
  assert.deepEqual(PRODUCT_PROFILE.search.regionCodes, ['za']);
  assert.equal(searchCountryCode(), 'ZA');
  assert.deepEqual(searchRegionCodes(), ['za']);
});

test('geocodeSearch calls Places Text Search from the browser with regionCode ZA', async () => {
  const priorFetch = globalThis.fetch;
  const priorWindow = globalThis.window;
  const calls = [];
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'browser-key' };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: [{
          id: 'places/test',
          displayName: { text: 'George' },
          formattedAddress: 'George, South Africa',
          location: { latitude: -33.9642, longitude: 22.4617 },
          viewport: {
            low: { latitude: -34.05, longitude: 22.35 },
            high: { latitude: -33.88, longitude: 22.55 },
          },
          types: ['locality', 'political'],
        }],
      }),
    };
  };
  try {
    const data = await geocodeSearch('George');
    assert.equal(data.status, 'OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'browser-key');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.textQuery, 'George');
    assert.equal(body.regionCode, 'ZA');
    assert.doesNotMatch(calls[0].url, /\/api\/google\//);
    assert.equal(data.results[0].formatted_address, 'George, South Africa');
    assert.equal(data.results[0].geometry.location.lat, -33.9642);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.window = priorWindow;
  }
});

test('geocodeSearch surfaces a missing client Maps key honestly', async () => {
  const priorFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: '' };
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
  try {
    assert.equal(clientMapsApiKey(), '');
    await assert.rejects(() => geocodeSearch('George'), /GOOGLE_MAPS_API_KEY/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
});

test('geocodeSearch surfaces a Google Places denial honestly', async () => {
  const priorFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'browser-key' };
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: 'Requests from referer <empty> are blocked.' } }),
  });
  try {
    await assert.rejects(() => geocodeSearch('George'), /blocked|denied/i);
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
});

test('placeResourceToGeocodeResult maps Places viewport into southwest/northeast', () => {
  const mapped = placeResourceToGeocodeResult({
    formattedAddress: 'Canal Walk, Cape Town',
    location: { latitude: -33.89, longitude: 18.51 },
    types: ['shopping_mall'],
    viewport: {
      low: { latitude: -33.9, longitude: 18.5 },
      high: { latitude: -33.88, longitude: 18.52 },
    },
  });
  assert.equal(mapped.geometry.location.lat, -33.89);
  assert.equal(mapped.geometry.viewport.southwest.lat, -33.9);
  assert.equal(mapped.geometry.viewport.northeast.lng, 18.52);
});

test('search path is browser Places, not Node /api/google proxies', () => {
  const searchMod = readFileSync(join(root, 'src/search/googlePlacesSearch.js'), 'utf8');
  const locations = readFileSync(join(root, 'src/locations.js'), 'utf8');
  const ui = readFileSync(join(root, 'src/ui.js'), 'utf8');
  const html = readFileSync(join(root, 'index.html'), 'utf8');

  assert.match(searchMod, /places\.googleapis\.com\/v1\/places:searchText/);
  assert.match(searchMod, /places\.googleapis\.com\/v1\/places:autocomplete/);
  assert.match(searchMod, /X-Goog-Api-Key/);
  assert.match(searchMod, /clientMapsApiKey/);
  assert.doesNotMatch(searchMod, /\/api\/google\/geocode/);
  assert.doesNotMatch(searchMod, /\/api\/google\/autocomplete/);
  assert.match(locations, /geocodeSearch/);
  assert.match(locations, /referrer-restricted/);
  assert.match(ui, /autocompleteSearch/);
  assert.match(html, /location-search-suggestions/);
});
