/**
 * Unit tests for Sites Access / traffic pure helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_TIME_MINUTES,
  FLOW_COVERAGE_SOFT_MIN,
  boundsAroundPin,
  cardinalSamplePoints,
  destinationPointDeg,
  filterSegmentsNearPin,
  flowCoverageNote,
  formatKm,
  greatCircleKm,
  polylineMidpoint,
  reachableCacheKey,
  roundCoordKey,
  spanDegForRadiusKm,
  summarizeFlowSegments,
  summarizeReachableBoundary,
} from './accessStatsSummary.js';
import { accessStatsDisplayModel } from './siteAccessStats.js';

describe('accessStatsSummary', () => {
  it('exposes 5/10/15 drive-time minutes', () => {
    assert.deepEqual([...DRIVE_TIME_MINUTES], [5, 10, 15]);
  });

  it('boundsAroundPin builds a finite box around the pin', () => {
    const b = boundsAroundPin(-33.92, 18.42, 1.5);
    assert.ok(b);
    assert.ok(b.south < -33.92 && b.north > -33.92);
    assert.ok(b.west < 18.42 && b.east > 18.42);
    assert.equal(boundsAroundPin(NaN, 18, 1), null);
  });

  it('spanDegForRadiusKm widens lon span near the poles-ish via cos(lat)', () => {
    const eq = spanDegForRadiusKm(0, 1);
    const mid = spanDegForRadiusKm(60, 1);
    assert.ok(mid.lonSpanDeg > eq.lonSpanDeg);
  });

  it('summarizeFlowSegments buckets free/slow/jam without inventing levels', () => {
    const summary = summarizeFlowSegments([
      { trafficLevel: 1, closure: false },
      { trafficLevel: 0.9, closure: false },
      { trafficLevel: 0.7, closure: false },
      { trafficLevel: 0.2, closure: true },
      { trafficLevel: NaN, closure: true }, // closure counted; level skipped
    ]);
    assert.equal(summary.total, 4);
    assert.equal(summary.free, 2);
    assert.equal(summary.slow, 1);
    assert.equal(summary.jam, 1);
    assert.equal(summary.closures, 2);
    assert.equal(summary.pctFree, 50);
    assert.equal(summary.pctSlow, 25);
    assert.equal(summary.pctJam, 25);
    assert.equal(summary.thinCoverage, true);
  });

  it('summarizeFlowSegments empty → null percents', () => {
    const summary = summarizeFlowSegments([]);
    assert.equal(summary.pctFree, null);
    assert.equal(summary.thinCoverage, true);
  });

  it('flowCoverageNote warns on thin or zero coverage', () => {
    assert.match(flowCoverageNote({ total: 0, thinCoverage: true }), /No TomTom flow/);
    assert.match(
      flowCoverageNote({ total: FLOW_COVERAGE_SOFT_MIN - 1, thinCoverage: true }),
      /thin coverage/
    );
    assert.equal(
      flowCoverageNote({ total: FLOW_COVERAGE_SOFT_MIN, thinCoverage: false }),
      null
    );
  });

  it('filterSegmentsNearPin keeps only nearby midpoints', () => {
    const pinLat = -33.9;
    const pinLon = 18.4;
    const near = {
      coords: [[18.401, -33.901], [18.402, -33.902]],
      trafficLevel: 1,
    };
    const far = {
      coords: [[19.5, -34.5], [19.51, -34.51]],
      trafficLevel: 0.2,
    };
    const kept = filterSegmentsNearPin([near, far], pinLat, pinLon, 2);
    assert.equal(kept.length, 1);
    assert.equal(kept[0], near);
  });

  it('polylineMidpoint averages vertices', () => {
    assert.deepEqual(
      polylineMidpoint([[10, 0], [20, 10]]),
      { lon: 15, lat: 5 }
    );
    assert.equal(polylineMidpoint([]), null);
  });

  it('summarizeReachableBoundary reports median/max km', () => {
    const origin = { lat: 0, lon: 0 };
    // ~111 km north and ~55.5 km east-ish — use known haversine via helper
    const n = destinationPointDeg(0, 0, 0, 10);
    const e = destinationPointDeg(0, 0, 90, 5);
    const ring = summarizeReachableBoundary(origin, [
      { latitude: n.lat, longitude: n.lon },
      { lat: e.lat, lon: e.lon },
    ]);
    assert.equal(ring.pointCount, 2);
    assert.ok(Math.abs(ring.maxKm - 10) < 0.05);
    assert.ok(Math.abs(ring.medianKm - 7.5) < 0.1);
  });

  it('reachableCacheKey rounds coordinates', () => {
    assert.equal(reachableCacheKey(-33.924123, 18.424999, 10), '-33.924,18.425,10');
    assert.equal(roundCoordKey(1.23456, 3), '1.235');
  });

  it('formatKm and cardinal samples are sane', () => {
    assert.equal(formatKm(null), '—');
    assert.equal(formatKm(3.1415), '3.1 km');
    assert.equal(formatKm(42.2), '42 km');
    const pts = cardinalSamplePoints(0, 0, 1);
    assert.equal(pts.length, 4);
    assert.ok(greatCircleKm(0, 0, pts[0].lat, pts[0].lon) > 0.9);
  });
});

describe('accessStatsDisplayModel', () => {
  it('renders live flow + drive rings without inventing demographics', () => {
    const model = accessStatsDisplayModel({
      flow: {
        mode: 'live',
        summary: {
          pctFree: 60,
          pctSlow: 30,
          pctJam: 10,
          total: 20,
          closures: 0,
          thinCoverage: false,
        },
        coverageNote: null,
        snapshotNote: 'Current snapshot from TomTom flow tiles (cached ~2 min) — not peak-hour historic.',
      },
      drive: {
        mode: 'live',
        rings: [
          { minutes: 5, state: 'ok', medianKm: 2.4, maxKm: 3.1 },
          { minutes: 10, state: 'ok', medianKm: 5.1, maxKm: 6.2 },
          { minutes: 15, state: 'budget', medianKm: null, maxKm: null },
        ],
        note: 'Distances only — no demographics inside the rings.',
      },
    });
    assert.match(model.flowLines[0], /60% free/);
    assert.match(model.flowLines[1], /No road closures/);
    assert.match(model.driveLines[0], /5 min/);
    assert.match(model.driveLines[2], /budget/);
    assert.ok(model.footnotes.some((f) => /snapshot/i.test(f)));
    assert.ok(model.footnotes.some((f) => /no demographics/i.test(f)));
  });

  it('honest simulated / unavailable copy when keyless', () => {
    const model = accessStatsDisplayModel({
      flow: {
        mode: 'simulated',
        summary: { total: 0 },
        coverageNote: 'No TomTom key — traffic layer uses a labeled simulation; live % are not invented here.',
        snapshotNote: null,
      },
      drive: {
        mode: 'unavailable',
        rings: [
          { minutes: 5, state: 'unavailable', medianKm: null, maxKm: null },
          { minutes: 10, state: 'unavailable', medianKm: null, maxKm: null },
          { minutes: 15, state: 'unavailable', medianKm: null, maxKm: null },
        ],
        note: 'Drive-time rings need a TomTom key (free-tier Routing). Not simulated.',
      },
    });
    assert.match(model.flowLines[0], /keyless/i);
    assert.ok(model.driveLines.every((l) => /unavailable/i.test(l)));
  });
});
