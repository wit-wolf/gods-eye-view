/**
 * Unit tests: centre detection + tenant vs competing-centre classification.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_CENTRE_RADIUS_M,
  TENANT_RADIUS_M,
  classifyRetailContext,
  detectHostCentre,
  groupTenantsByCategory,
  isShoppingCentre,
  isTenantOfCentre,
  tenantCategoryKey,
} from './retailContext.js';
import { osmMallElementToFeature } from './siteResearch.js';

/** ~Cape Town CBD-ish fixture origin (not a live call). */
const PIN = { lat: -33.9700, lon: 18.4650 };

function centre(name, distKm, extras = {}) {
  // Rough: 1° lat ≈ 111 km — offset north by distKm.
  const dLat = distKm / 111;
  return {
    id: `centre-${name}`,
    name,
    primaryType: 'shopping center',
    types: ['shopping center'],
    categoryIds: [7373],
    lat: PIN.lat + dLat,
    lon: PIN.lon,
    distanceM: Math.round(distKm * 1000),
    ...extras,
  };
}

function store(name, distMFromPin, extras = {}) {
  const dLat = distMFromPin / 111_000;
  return {
    id: `store-${name}`,
    name,
    primaryType: extras.primaryType || 'shop',
    types: extras.types || ['shop'],
    categoryIds: extras.categoryIds || [9361],
    lat: PIN.lat + dLat,
    lon: PIN.lon + (extras.dLon || 0),
    distanceM: distMFromPin,
    ...extras,
  };
}

describe('isShoppingCentre', () => {
  it('detects TomTom category 7373 and shopping-centre type strings', () => {
    assert.equal(isShoppingCentre({ categoryIds: [7373], name: 'X' }), true);
    assert.equal(isShoppingCentre({ primaryType: 'shopping center', name: 'X' }), true);
    assert.equal(isShoppingCentre({ types: ['Shopping Centre'], name: 'X' }), true);
    assert.equal(isShoppingCentre({ primaryType: 'shop', name: 'Truworths' }), false);
  });
});

describe('detectHostCentre', () => {
  it('returns the centre within ~250 m and ignores farther malls', () => {
    const host = centre('Canal Walk', 0.08); // 80 m
    const other = centre('Century City', 2.5);
    const found = detectHostCentre(PIN.lat, PIN.lon, [other, host]);
    assert.ok(found);
    assert.equal(found.name, 'Canal Walk');
    assert.ok(found.distanceM <= HOST_CENTRE_RADIUS_M);
  });

  it('returns null when no centre is within the host radius', () => {
    const found = detectHostCentre(PIN.lat, PIN.lon, [
      centre('Far Mall', 1.2),
      centre('Farther Mall', 4),
    ]);
    assert.equal(found, null);
  });
});

describe('classifyRetailContext — pin on a mall', () => {
  it('puts ~20 in-mall stores in tenants and 3 other malls in competing centres', () => {
    const host = centre('V&A Waterfront', 0.05); // 50 m — pin ON the mall
    const competing = [
      centre('Canal Walk', 2.4),
      centre('Century City', 5.1),
      centre('Tyger Valley', 7.8),
    ];
    const tenantNames = [
      'Identity', 'Truworths', 'Edgars', 'Studio 88', 'Sportscene',
      'Woolworths', 'Foschini', 'Mr Price', 'Cotton On', 'Exact',
      'Markham', 'Jet', 'Ackermans', 'Totalsports', 'Cape Union Mart',
      'Clicks', 'Dis-Chem', 'Pick n Pay', 'Starbucks', 'Nando\'s',
    ];
    assert.equal(tenantNames.length, 20);
    const tenants = tenantNames.map((name, i) => store(name, 40 + i * 5, {
      primaryType: i >= 18 ? 'restaurant' : i >= 16 ? 'pharmacy' : 'shop',
      types: i >= 18 ? ['restaurant'] : i >= 16 ? ['pharmacy'] : ['shop'],
      categoryIds: i >= 18 ? [] : i >= 16 ? [] : [9361],
    }));
    // A store well outside the centre should not become a tenant.
    const outside = store('Distant DIY', 1800, {
      primaryType: 'shop',
      categoryIds: [9361],
    });

    const result = classifyRetailContext({
      latitude: PIN.lat,
      longitude: PIN.lon,
      centres: [host, ...competing],
      stores: [...tenants, outside],
    });

    assert.equal(result.mode, 'in_centre');
    assert.equal(result.hostCentre.name, 'V&A Waterfront');
    assert.equal(result.tenants.length, 20);
    assert.ok(result.tenants.every((t) => t.distanceM <= TENANT_RADIUS_M));
    assert.ok(!result.tenants.some((t) => t.name === 'Distant DIY'));
    assert.equal(result.competingWithin10km.length, 3);
    assert.equal(result.competingWithin5km.length, 1); // Canal Walk only
    assert.deepEqual(
      result.competingWithin10km.map((c) => c.name),
      ['Canal Walk', 'Century City', 'Tyger Valley'],
    );
    assert.ok(!result.competingCentres.some((c) => c.name === 'V&A Waterfront'));
    assert.equal(result.retailNearby.length, 0);

    const groups = groupTenantsByCategory(result.tenants);
    assert.ok(groups.some((g) => g.key === 'food' && g.places.length >= 2));
    assert.ok(groups.some((g) => g.key === 'other' || g.key === 'fashion' || g.key === 'services'));
  });
});

describe('classifyRetailContext — open land / standalone site', () => {
  it('keeps Retail nearby + Competing centres when pin is not in a centre', () => {
    const competing = [
      centre('Mall A', 1.5),
      centre('Mall B', 6.0),
    ];
    const stores = [
      store('Checkers', 400, { primaryType: 'supermarket', categoryIds: [7332] }),
      store('Builders', 900, { primaryType: 'shop', categoryIds: [9361] }),
      store('Far Shop', 3200, { primaryType: 'shop', categoryIds: [9361] }),
    ];

    const result = classifyRetailContext({
      latitude: PIN.lat,
      longitude: PIN.lon,
      centres: competing,
      stores,
    });

    assert.equal(result.mode, 'open_site');
    assert.equal(result.hostCentre, null);
    assert.equal(result.tenants.length, 0);
    assert.equal(result.retailWithin2km.length, 2);
    assert.equal(result.retailWithin5km.length, 3);
    assert.equal(result.competingWithin5km.length, 1);
    assert.equal(result.competingWithin10km.length, 2);
  });
});

describe('isTenantOfCentre + tenantCategoryKey', () => {
  it('uses mall polygon containment when provided', () => {
    const host = centre('Boxed Mall', 0.05);
    // Simple square around the pin (~200 m ≈ 0.0018°).
    const mallFeature = {
      type: 'Feature',
      properties: { name: 'Boxed Mall' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [PIN.lon - 0.002, PIN.lat - 0.002],
          [PIN.lon + 0.002, PIN.lat - 0.002],
          [PIN.lon + 0.002, PIN.lat + 0.002],
          [PIN.lon - 0.002, PIN.lat + 0.002],
          [PIN.lon - 0.002, PIN.lat - 0.002],
        ]],
      },
    };
    const inside = store('Inside Brand', 150);
    const outside = {
      ...store('Outside Brand', 900),
      lat: PIN.lat + 0.01,
      lon: PIN.lon + 0.01,
      distanceM: 1400,
    };
    assert.equal(isTenantOfCentre(inside, host, mallFeature), true);
    assert.equal(isTenantOfCentre(outside, host, mallFeature), false);
  });

  it('maps TomTom types to landlord categories without inventing brands', () => {
    assert.equal(tenantCategoryKey({ categoryIds: [7327] }), 'department store');
    assert.equal(tenantCategoryKey({ categoryIds: [7332] }), 'grocery');
    assert.equal(tenantCategoryKey({ primaryType: 'restaurant' }), 'food');
    assert.equal(tenantCategoryKey({ types: ['clothing store'] }), 'fashion');
    assert.equal(tenantCategoryKey({ primaryType: 'shop', categoryIds: [9361] }), 'other');
  });
});

describe('osmMallElementToFeature', () => {
  it('builds a polygon from an Overpass shop=mall way geometry', () => {
    const el = {
      type: 'way',
      id: 1,
      tags: { shop: 'mall', name: 'Test Mall' },
      geometry: [
        { lat: PIN.lat - 0.001, lon: PIN.lon - 0.001 },
        { lat: PIN.lat - 0.001, lon: PIN.lon + 0.001 },
        { lat: PIN.lat + 0.001, lon: PIN.lon + 0.001 },
        { lat: PIN.lat + 0.001, lon: PIN.lon - 0.001 },
        { lat: PIN.lat - 0.001, lon: PIN.lon - 0.001 },
      ],
    };
    const feature = osmMallElementToFeature([el], PIN.lat, PIN.lon);
    assert.ok(feature);
    assert.equal(feature.geometry.type, 'Polygon');
    assert.equal(feature.properties.name, 'Test Mall');
  });
});
