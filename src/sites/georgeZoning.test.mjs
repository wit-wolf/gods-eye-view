/**
 * Unit tests for George zoning bbox helpers (no network).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEORGE_MUNICIPALITY,
  GEORGE_ZONING_FEATURE_SERVER,
  GEORGE_ZONING_HALF_DEG,
  GEORGE_ZONING_RESULT_RECORD_COUNT,
  buildGeorgeZoningQueryUrl,
  readGeorgeZoningProps,
} from './georgeZoning.js';
import { CENSUS_2022_NOT_PUBLIC_MESSAGE } from './siteDemographics.js';

describe('georgeZoning helpers', () => {
  it('builds a bbox Feature query with capped fields and record count', () => {
    const url = buildGeorgeZoningQueryUrl(-33.964, 22.461);
    assert.ok(url.startsWith(GEORGE_ZONING_FEATURE_SERVER));
    const u = new URL(url);
    assert.equal(u.searchParams.get('f'), 'geojson');
    assert.equal(u.searchParams.get('outFields'), 'zoning,zoning_code,land_use,town');
    assert.equal(u.searchParams.get('resultRecordCount'), String(GEORGE_ZONING_RESULT_RECORD_COUNT));
    assert.equal(u.searchParams.get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(u.searchParams.get('inSR'), '4326');
    assert.equal(u.searchParams.get('outSR'), '4326');
    const geom = JSON.parse(u.searchParams.get('geometry'));
    assert.ok(Math.abs(geom.xmin - (22.461 - GEORGE_ZONING_HALF_DEG)) < 1e-9);
    assert.ok(Math.abs(geom.ymax - (-33.964 + GEORGE_ZONING_HALF_DEG)) < 1e-9);
  });

  it('reads George attribute aliases', () => {
    const fields = readGeorgeZoningProps({
      zoning: 'Single Residential Zone I',
      zoning_code: 'SRZI',
      land_use: 'Residential',
      town: 'GEORGE',
    });
    assert.equal(fields.zoneCode, 'SRZI');
    assert.equal(fields.zoneName, 'Single Residential Zone I');
    assert.equal(fields.landUse, 'Residential');
    assert.equal(fields.town, 'GEORGE');
    assert.equal(GEORGE_MUNICIPALITY, 'George Municipality');
  });
});

describe('siteDemographics Census 2022 copy', () => {
  it('exposes the verified not-public message', () => {
    assert.match(CENSUS_2022_NOT_PUBLIC_MESSAGE, /Census 2022 small-area not public/);
    assert.match(CENSUS_2022_NOT_PUBLIC_MESSAGE, /SuperWEB2/);
  });
});
