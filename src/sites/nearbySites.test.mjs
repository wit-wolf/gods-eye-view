import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearbySites,
  formatDistanceM,
  haversineMetres,
} from './nearbySites.js';
import {
  descriptionFromProperties,
  folderFromProperties,
  formatCoordinates,
  kmlAttributeRows,
  stripHtmlToText,
} from './kmlText.js';

test('haversineMetres is ~0 for the same point', () => {
  assert.ok(haversineMetres(-33.92, 18.42, -33.92, 18.42) < 1);
});

test('findNearbySites counts pins inside 2 km and excludes focus', () => {
  const focus = { uid: 'a', name: 'Focus', latitude: -33.9249, longitude: 18.4241 };
  const near = { uid: 'b', name: 'Near Mall', latitude: -33.93, longitude: 18.43 };
  const far = { uid: 'c', name: 'Far Pin', latitude: -26.2, longitude: 28.0 };
  const nearby = findNearbySites({
    focusUid: focus.uid,
    latitude: focus.latitude,
    longitude: focus.longitude,
    sites: [focus, near, far],
    radiusM: 2000,
  });
  assert.equal(nearby.length, 1);
  assert.equal(nearby[0].uid, 'b');
  assert.ok(nearby[0].distanceM < 2000);
});

test('formatDistanceM switches to km', () => {
  assert.equal(formatDistanceM(250), '250 m');
  assert.match(formatDistanceM(2500), /2\.5 km/);
});

test('stripHtmlToText removes tags and keeps line breaks', () => {
  assert.equal(
    stripHtmlToText('<b>Checkers</b><br/>Woolworths&amp;Co'),
    'Checkers\nWoolworths&Co',
  );
});

test('descriptionFromProperties and kmlAttributeRows ignore style noise', () => {
  const props = {
    name: 'Heiderand Mall',
    _uid: 'x',
    _layerId: 'demo',
    description: '<div>Checkers<br/>Clicks</div>',
    visibility: false,
    'icon-scale': 0.6,
    address: 'Cape Town',
  };
  assert.equal(descriptionFromProperties(props), 'Checkers\nClicks');
  const rows = kmlAttributeRows(props);
  assert.deepEqual(rows, [['address', 'Cape Town']]);
});

test('folderFromProperties falls back to layer name', () => {
  assert.equal(folderFromProperties({}, 'November Google Earth Pins'), 'November Google Earth Pins');
  assert.equal(folderFromProperties({ folder: 'Retail / CPT' }, 'x'), 'Retail / CPT');
});

test('formatCoordinates labels hemisphere', () => {
  assert.equal(formatCoordinates(-33.9249, 18.4241), '33.92490°S, 18.42410°E');
  assert.equal(formatCoordinates(null, 18), 'Coordinates unavailable');
});
