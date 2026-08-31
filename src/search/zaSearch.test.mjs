import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PRODUCT_PROFILE } from '../productProfile.js';
import {
  geocodeSearch,
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

test('geocodeSearch uses the ZA country proxy and surfaces missing keys', async () => {
  const priorFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'OK',
        results: [{
          formatted_address: 'George, South Africa',
          geometry: { location: { lat: -33.9642, lng: 22.4617 } },
          types: ['locality', 'political'],
        }],
      }),
    };
  };
  try {
    const data = await geocodeSearch('George');
    assert.equal(data.status, 'OK');
    assert.match(calls[0], /\/api\/google\/geocode\?/);
    assert.match(calls[0], /country=ZA/);
    assert.match(calls[0], /q=George/);
    assert.equal(data.results[0].formatted_address, 'George, South Africa');
  } finally {
    globalThis.fetch = priorFetch;
  }

  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'GOOGLE_MAPS_API_KEY is not set', status: 'REQUEST_DENIED', results: [] }),
  });
  try {
    await assert.rejects(() => geocodeSearch('George'), /GOOGLE_MAPS_API_KEY/);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('searchAndFlyTo and Vite proxies pin ZA geocode + autocomplete routes', () => {
  const locations = readFileSync(join(root, 'src/locations.js'), 'utf8');
  const vite = readFileSync(join(root, 'vite.config.js'), 'utf8');
  const ui = readFileSync(join(root, 'src/ui.js'), 'utf8');
  const html = readFileSync(join(root, 'index.html'), 'utf8');

  assert.match(locations, /geocodeSearch/);
  assert.match(locations, /searchCountryCode\(PRODUCT_PROFILE\)/);
  assert.match(locations, /placeDetailsSearch/);
  assert.match(vite, /middlewares\.use\('\/api\/google\/geocode'/);
  assert.match(vite, /middlewares\.use\('\/api\/google\/autocomplete'/);
  assert.match(vite, /middlewares\.use\('\/api\/google\/place'/);
  assert.match(vite, /components.*country:/);
  assert.match(vite, /includedRegionCodes/);
  assert.match(vite, /regionCode/);
  assert.match(ui, /_runLocationSearch/);
  assert.match(ui, /autocompleteSearch/);
  assert.match(ui, /No South African place found/);
  assert.match(html, /location-search-suggestions/);
  assert.match(html, /Search South Africa/);
});
