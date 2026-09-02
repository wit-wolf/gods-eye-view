/**
 * Unit tests for Ancora occupancy-from-units helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCORA_GEOCODE_CAVEATS,
  ancoraOccupancyFromUnits,
  ancoraWasGeocoded,
} from './ancoraCentreFields.js';

describe('ancoraOccupancyFromUnits', () => {
  it('computes occupancy_pct from units_occupied/units when units>0', () => {
    const o = ancoraOccupancyFromUnits({ units: 20, units_occupied: 15 });
    assert.equal(o.units, 20);
    assert.equal(o.occupied, 15);
    assert.equal(o.vacant, 5);
    assert.equal(o.occupancyPct, 75);
  });

  it('does not invent occupancy when units are missing', () => {
    const o = ancoraOccupancyFromUnits({ units_occupied: 3 });
    assert.equal(o.units, null);
    assert.equal(o.occupancyPct, null);
  });

  it('uses explicit vacant when provided', () => {
    const o = ancoraOccupancyFromUnits({ units: 10, units_occupied: 7, units_vacant: 2 });
    assert.equal(o.vacant, 2);
    assert.equal(o.occupancyPct, 70);
  });
});

describe('ancoraWasGeocoded', () => {
  it('detects geocoded_name / address', () => {
    assert.equal(ancoraWasGeocoded({ geocoded_name: 'Foo' }), true);
    assert.equal(ancoraWasGeocoded({ name: 'Foo' }), false);
  });

  it('lists known caveats', () => {
    assert.ok(ANCORA_GEOCODE_CAVEATS.length >= 4);
  });
});
