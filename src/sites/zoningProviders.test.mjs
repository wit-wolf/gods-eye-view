/**
 * Unit tests for location-aware zoning provider selection (no network).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPE_TOWN_ZONING_PROVIDER,
  GEORGE_ZONING_PROVIDER,
  NO_ZONING_DATA_MESSAGE,
  buildZoningQueryUrl,
  noZoningDataResult,
  pointInZoningExtent,
  readZoningProps,
  selectZoningProvider,
} from './zoningProviders.js';

describe('zoning provider selection', () => {
  it('selects George inside the municipal extent', () => {
    const p = selectZoningProvider(-33.964, 22.461);
    assert.equal(p?.id, 'george');
    assert.equal(p?.municipality, 'George Municipality');
  });

  it('selects Cape Town inside the CoCT extent', () => {
    const p = selectZoningProvider(-33.9249, 18.4241);
    assert.equal(p?.id, 'cape-town');
    assert.equal(p?.municipality, 'City of Cape Town');
    assert.match(p.featureServer, /ODP_SPLIT_5\/FeatureServer\/0/);
  });

  it('returns null outside every registered municipality (no George label)', () => {
    // Johannesburg CBD — must not fall through to George.
    const p = selectZoningProvider(-26.2041, 28.0473);
    assert.equal(p, null);
    const miss = noZoningDataResult();
    assert.equal(miss.message, NO_ZONING_DATA_MESSAGE);
    assert.equal(miss.municipality, null);
    assert.equal(miss.source, 'none');
  });

  it('pointInZoningExtent rejects edges outside the box', () => {
    assert.equal(
      pointInZoningExtent(-33.964, 22.461, GEORGE_ZONING_PROVIDER.extent),
      true,
    );
    assert.equal(
      pointInZoningExtent(-26.2, 28.0, GEORGE_ZONING_PROVIDER.extent),
      false,
    );
    assert.equal(
      pointInZoningExtent(-33.92, 18.42, CAPE_TOWN_ZONING_PROVIDER.extent),
      true,
    );
  });
});

describe('zoning provider field mapping', () => {
  it('builds George and Cape Town query URLs with verified outFields', () => {
    const georgeUrl = buildZoningQueryUrl(GEORGE_ZONING_PROVIDER, -33.964, 22.461);
    assert.ok(georgeUrl.startsWith(GEORGE_ZONING_PROVIDER.featureServer));
    assert.match(georgeUrl, /zoning%2Czoning_code%2Cland_use%2Ctown|zoning,zoning_code/);

    const ctUrl = buildZoningQueryUrl(CAPE_TOWN_ZONING_PROVIDER, -33.92, 18.42);
    assert.ok(ctUrl.startsWith(CAPE_TOWN_ZONING_PROVIDER.featureServer));
    const u = new URL(ctUrl);
    assert.equal(u.searchParams.get('outFields'), 'INT_ZONE_CODE,INT_ZONE_DESC');
    assert.equal(u.searchParams.get('f'), 'geojson');
  });

  it('reads Cape Town INT_ZONE_* aliases', () => {
    const fields = readZoningProps(CAPE_TOWN_ZONING_PROVIDER, {
      INT_ZONE_CODE: 'GB7',
      INT_ZONE_DESC: 'General Business 7',
    });
    assert.equal(fields.zoneCode, 'GB7');
    assert.equal(fields.zoneName, 'General Business 7');
  });

  it('reads George zoning aliases', () => {
    const fields = readZoningProps(GEORGE_ZONING_PROVIDER, {
      zoning: 'Single Residential Zone I',
      zoning_code: 'SRZI',
      land_use: 'Residential',
      town: 'GEORGE',
    });
    assert.equal(fields.zoneCode, 'SRZI');
    assert.equal(fields.zoneName, 'Single Residential Zone I');
    assert.equal(fields.landUse, 'Residential');
    assert.equal(fields.town, 'GEORGE');
  });
});
