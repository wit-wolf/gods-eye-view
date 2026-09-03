// Overpass proxy Tier A hardening (voice-engine evaluation doc §4.1, field test
// 2026-07-23): region/state boundary pivots return multi-MB coastline geometry that
// blew the old 12 MB read cap and 16 s client budget (Sicily never traced). The proxy
// now simplifies giant `out geom` payloads server-side before caching/serving, and
// boundary-class queries (is_in / pivot) get a longer disk TTL — boundaries change
// ≈never. Pure-function tests, no network.
//
// Also covers the 2026-09 Street Traffic outage: overpass-api.de 406 HTML was
// cached as a "success" (~573 B poison files), so road fetch parsed zero ways.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simplifyOverpassPayloadBody,
  isOverpassBoundaryQuery,
  resolveOverpassPreflight,
  isValidOverpassOsmBody,
  isUsableOverpassCacheEntry,
  fetchOverpassPayload,
} from '../../vite.config.js';

test('preflight checks memory, in-flight, then disk before consuming limiter quota', async () => {
  const key = 'normalized query';
  const osmBody = JSON.stringify({ elements: [{ type: 'way', id: 1 }] });
  const fresh = {
    id: 'memory', status: 200, body: osmBody, contentType: 'application/json', cachedAt: 900,
  };
  const joined = {
    id: 'inflight', status: 200, body: osmBody, contentType: 'application/json', cachedAt: 950,
  };
  const disk = {
    id: 'disk', status: 200, body: osmBody, contentType: 'application/json', cachedAt: 975,
  };
  let diskReads = 0;
  let limiterCalls = 0;
  const allowUpstream = () => { limiterCalls += 1; return true; };

  const memoryHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, fresh]]),
    inFlight: new Map([[key, Promise.resolve(joined)]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(memoryHit.source, 'HIT');
  assert.equal(memoryHit.payload, fresh);
  assert.equal(diskReads, 0, 'memory hit must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'memory hit must not consume limiter quota');

  const inFlightHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, { id: 'stale', status: 200, body: osmBody, cachedAt: 0 }]]),
    inFlight: new Map([[key, Promise.resolve(joined)]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(inFlightHit.source, 'INFLIGHT');
  assert.equal(inFlightHit.payload, joined);
  assert.equal(diskReads, 0, 'in-flight join must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'in-flight join must not consume limiter quota');

  const diskHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
  });
  assert.equal(diskHit.source, 'DISK');
  assert.equal(diskHit.payload, disk);
  assert.equal(diskReads, 1);
  assert.equal(limiterCalls, 0, 'disk hit must not consume limiter quota');

  const upstreamMiss = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return null; },
    allowUpstream,
  });
  assert.equal(upstreamMiss.source, 'UPSTREAM');
  assert.equal(diskReads, 2, 'disk must be checked before upstream admission');
  assert.equal(limiterCalls, 1, 'only a complete cache miss consumes quota');

  const denied = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => null,
    allowUpstream: () => false,
  });
  assert.equal(denied.source, 'RATE_LIMITED');
});

/** Synthetic dense ring: N points on a circle with sub-tolerance jitter. */
function denseRing(n, { latC = 37.5, lonC = 14.2, radiusDeg = 0.5 } = {}) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    // Jitter far below the simplification tolerance so the ring is genuinely
    // redundant — a correct simplifier should collapse most of it.
    const jitter = (i % 7) * 0.000004;
    pts.push({
      lat: latC + Math.sin(a) * (radiusDeg + jitter),
      lon: lonC + Math.cos(a) * (radiusDeg + jitter),
    });
  }
  pts.push({ ...pts[0] }); // closed ring
  return pts;
}

const TEST_OPTS = { minBytes: 0, minPoints: 200, toleranceDeg: 0.0004 };

test('simplify: giant way geometry is decimated, endpoints preserved', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 1, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  assert.ok(g.length < ring.length * 0.5, `should shed most redundant points, got ${g.length}/${ring.length}`);
  assert.ok(g.length >= 16, `must keep enough points to stay a ring, got ${g.length}`);
  assert.deepEqual(g[0], ring[0]);
  assert.deepEqual(g[g.length - 1], ring[ring.length - 1]);
});

test('simplify: relation member geometries are decimated too', () => {
  const ring = denseRing(3000);
  const body = JSON.stringify({
    elements: [{
      type: 'relation',
      id: 2,
      members: [
        { type: 'way', role: 'outer', geometry: ring },
        { type: 'node', role: 'admin_centre' }, // no geometry — must survive untouched
      ],
    }],
  });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.ok(out.elements[0].members[0].geometry.length < ring.length * 0.5);
  assert.equal(out.elements[0].members[1].geometry, undefined);
});

test('simplify: small geometries (building footprints) pass through untouched', () => {
  const square = [
    { lat: 30.27, lon: -97.74 }, { lat: 30.271, lon: -97.74 },
    { lat: 30.271, lon: -97.741 }, { lat: 30.27, lon: -97.741 },
    { lat: 30.27, lon: -97.74 },
  ];
  const body = JSON.stringify({ elements: [{ type: 'way', id: 3, geometry: square }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.deepEqual(out.elements[0].geometry, square);
});

test('simplify: geometry stays within tolerance of the original shape', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 4, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  // Every original vertex must lie near SOME kept vertex — a circle of kept
  // points at spacing s has every dropped point within ~s/2 along the arc, and
  // DP guarantees perpendicular deviation ≤ tolerance. Loose sanity bound: no
  // original point farther than 8× tolerance from the nearest kept point pair
  // is possible for a smooth ring; check a sampled subset for speed.
  for (let i = 0; i < ring.length; i += 97) {
    const p = ring[i];
    let best = Infinity;
    for (let j = 1; j < g.length; j++) {
      const d = pointSegDistDeg(p, g[j - 1], g[j]);
      if (d < best) best = d;
    }
    assert.ok(best <= TEST_OPTS.toleranceDeg * 1.01, `vertex ${i} deviates ${best} deg`);
  }
});

test('simplify: sub-threshold bodies and non-JSON pass through byte-identical', () => {
  const tiny = JSON.stringify({ elements: [{ type: 'way', geometry: denseRing(3000) }] });
  assert.equal(simplifyOverpassPayloadBody(tiny, { ...TEST_OPTS, minBytes: tiny.length + 1 }), tiny);
  const junk = 'this is not json {';
  assert.equal(simplifyOverpassPayloadBody(junk, TEST_OPTS), junk);
});

test('boundary-class queries detected for the long disk TTL', () => {
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];is_in(37.5,14.2)->.a;area.a["boundary"="administrative"]["admin_level"];out tags;',
  ), true);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];area(3600039152)->.x;rel(pivot.x);out geom;',
  ), true);
  // The enclosing-compound sweep and road fetches keep the default TTL.
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];( way(around:1200,30.27,-97.74)["leisure"]["name"]; );out geom;',
  ), false);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:12];way["highway"~"motorway|trunk"](30.1,-97.9,30.5,-97.5);out geom;',
  ), false);
});

/** Perpendicular distance (deg, planar approx) from p to segment a-b. */
function pointSegDistDeg(p, a, b) {
  const vx = b.lon - a.lon;
  const vy = b.lat - a.lat;
  const wx = p.lon - a.lon;
  const wy = p.lat - a.lat;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.lon - b.lon, p.lat - b.lat);
  const t = c1 / c2;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

// ── Poison-cache / 406 fallthrough (Street Traffic outage fix) ───────────────

/** ~573-byte-class HTML error page like overpass-api.de 406 responses. */
const POISON_406_HTML = `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>406 Not Acceptable</title>
</head><body>
<h1>Not Acceptable</h1>
<p>An appropriate representation of the requested resource could not be found on this server.</p>
</body></html>
`;

const VALID_OSM_JSON = JSON.stringify({
  version: 0.6,
  generator: 'Overpass API',
  elements: [
    {
      type: 'way',
      id: 1,
      tags: { highway: 'residential' },
      geometry: [{ lat: 29.42, lon: -98.49 }, { lat: 29.421, lon: -98.491 }],
    },
  ],
});

function mockResponse(status, body, contentType = 'text/html') {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    // No body.getReader — readResponseTextCapped falls back to .text().
    text: async () => body,
  };
}

test('isValidOverpassOsmBody accepts OSM JSON and rejects HTML/error bodies', () => {
  assert.equal(isValidOverpassOsmBody(VALID_OSM_JSON), true);
  assert.equal(isValidOverpassOsmBody(JSON.stringify({ elements: [] })), true);
  assert.equal(isValidOverpassOsmBody(POISON_406_HTML), false);
  assert.equal(isValidOverpassOsmBody('<html>rate limited</html>'), false);
  assert.equal(isValidOverpassOsmBody('{not json'), false);
  assert.equal(isValidOverpassOsmBody(JSON.stringify({ error: 'nope' })), false);
  assert.equal(isValidOverpassOsmBody(''), false);
});

test('isUsableOverpassCacheEntry rejects 406/HTML poison and non-2xx', () => {
  assert.equal(isUsableOverpassCacheEntry({
    status: 200, body: VALID_OSM_JSON, cachedAt: Date.now(),
  }), true);
  assert.equal(isUsableOverpassCacheEntry({
    status: 406, body: POISON_406_HTML, cachedAt: Date.now(),
  }), false);
  assert.equal(isUsableOverpassCacheEntry({
    status: 200, body: POISON_406_HTML, cachedAt: Date.now(),
  }), false);
  assert.equal(isUsableOverpassCacheEntry({
    status: 429, body: 'rate_limited', rateLimited: true, cachedAt: Date.now(),
  }), false);
});

test('406 HTML falls through to the next Overpass mirror', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('overpass-api.de')) {
      return mockResponse(406, POISON_406_HTML, 'text/html');
    }
    return mockResponse(200, VALID_OSM_JSON, 'application/json');
  };
  const payload = await fetchOverpassPayload('data=test', 1_000_000, {
    fetchImpl,
    upstreams: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ],
  });
  assert.equal(calls.length, 2, 'must try the second mirror after 406');
  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, 'https://overpass.kumi.systems/api/interpreter');
  assert.equal(isValidOverpassOsmBody(payload.body), true);
  assert.match(payload.body, /"elements"/);
});

test('HTML / non-OSM bodies are never accepted as a successful mirror response', async () => {
  const fetchImpl = async () => mockResponse(200, POISON_406_HTML, 'text/html');
  await assert.rejects(
    () => fetchOverpassPayload('data=test', 1_000_000, {
      fetchImpl,
      upstreams: ['https://mirror.example/api/interpreter'],
    }),
    /non-OSM|All Overpass/,
  );
});

test('poisoned memory cache entry is not served — falls through to upstream', async () => {
  const key = 'poisoned highway query';
  const poison = {
    status: 406,
    body: POISON_406_HTML,
    contentType: 'text/html',
    endpoint: 'https://overpass-api.de/api/interpreter',
    cachedAt: Date.now(),
  };
  const memoryCache = new Map([[key, poison]]);
  let limiterCalls = 0;
  const result = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache,
    inFlight: new Map(),
    readDisk: async () => null,
    allowUpstream: () => { limiterCalls += 1; return true; },
    now: Date.now(),
    cacheMs: 86_400_000,
  });
  assert.equal(result.source, 'UPSTREAM');
  assert.equal(memoryCache.has(key), false, 'poison entry must be deleted from memory');
  assert.equal(limiterCalls, 1);
});

test('poisoned disk-shaped payload is not served as a DISK hit', async () => {
  const key = 'disk poison';
  const poison = {
    status: 406,
    body: POISON_406_HTML,
    contentType: 'text/html',
    endpoint: 'https://overpass-api.de/api/interpreter',
    cachedAt: Date.now(),
  };
  const result = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => poison,
    allowUpstream: () => true,
  });
  assert.equal(result.source, 'UPSTREAM', 'invalid disk stub must not become a DISK hit');
});

test('valid OSM cache entry still hits memory preflight', async () => {
  const key = 'good roads';
  const good = {
    status: 200,
    body: VALID_OSM_JSON,
    contentType: 'application/json',
    endpoint: 'https://overpass.kumi.systems/api/interpreter',
    cachedAt: Date.now() - 1000,
  };
  const result = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, good]]),
    inFlight: new Map(),
    readDisk: async () => null,
    allowUpstream: () => true,
    now: Date.now(),
    cacheMs: 86_400_000,
  });
  assert.equal(result.source, 'HIT');
  assert.equal(result.payload, good);
});
