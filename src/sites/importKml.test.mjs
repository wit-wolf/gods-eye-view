import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import {
  extractKMLFromKMZ,
  generateFeatureUID,
  getBounds,
  getGeometryTypes,
  parseFileContent,
  parseGzippedGeoJSON,
  parseKML,
  processGeoJSON,
} from './importKml.js';
import {
  calculateScore,
  createScoredSite,
  DEFAULT_SCORING_WEIGHTS,
  filterSitesByStatus,
  getDefaultScoreInputs,
  normalizeScoreInputs,
  sortSitesByScore,
} from './scoring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO_KMZ = path.join(ROOT, 'public/sites/November_Google_Earth_Pins.kmz');
const DEMO_GZ = path.join(ROOT, 'public/sites/november_pins.geojson.gz');

const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Cape Town Lead</name>
      <Point><coordinates>18.4241,-33.9249,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Poly Site</name>
      <Polygon>
        <outerBoundaryIs><LinearRing>
          <coordinates>
            18.42,-33.92,0
            18.43,-33.92,0
            18.43,-33.93,0
            18.42,-33.92,0
          </coordinates>
        </LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;

test('parseKML converts placemarks to Point and Polygon features', () => {
  const geojson = parseKML(SAMPLE_KML, { DOMParser });
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, 2);
  assert.deepEqual(getGeometryTypes(geojson).sort(), ['Point', 'Polygon']);
});

test('processGeoJSON stamps stable UIDs and display names', () => {
  const raw = parseKML(SAMPLE_KML, { DOMParser });
  const processed = processGeoJSON(raw, 'layer-a');
  assert.equal(processed.features.length, 2);
  for (const feature of processed.features) {
    assert.ok(feature.properties._uid.startsWith('layer-a:'));
    assert.equal(feature.properties._layerId, 'layer-a');
    assert.ok(feature.properties._name);
  }
  const again = processGeoJSON(raw, 'layer-a');
  assert.equal(again.features[0].properties._uid, processed.features[0].properties._uid);
});

test('generateFeatureUID prefers feature id then name hash', () => {
  assert.equal(
    generateFeatureUID({ id: 'abc', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }, 'L', 0),
    'L:abc',
  );
  const named = generateFeatureUID({
    properties: { name: 'Pin' },
    geometry: { type: 'Point', coordinates: [1, 2] },
  }, 'L', 3);
  assert.match(named, /^L:Pin:/);
});

test('getBounds returns lon/lat envelope', () => {
  const geojson = processGeoJSON(parseKML(SAMPLE_KML, { DOMParser }), 'b');
  const bounds = getBounds(geojson);
  assert.ok(bounds);
  const [[west, south], [east, north]] = bounds;
  assert.ok(west <= 18.42);
  assert.ok(east >= 18.43);
  assert.ok(south <= -33.93);
  assert.ok(north >= -33.92);
});

test('parseFileContent accepts GeoJSON passthrough', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'X' },
      geometry: { type: 'Point', coordinates: [18.4, -33.9] },
    }],
  };
  assert.deepEqual(parseFileContent(JSON.stringify(fc), 'sites.geojson'), fc);
});

test('extractKMLFromKMZ reads bundled November demo archive', async () => {
  const fileBuf = readFileSync(DEMO_KMZ);
  const ab = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
  const kml = await extractKMLFromKMZ(ab);
  assert.match(kml, /<kml/i);
  assert.ok(kml.length > 1000);
});

test('parseGzippedGeoJSON loads bundled november demo subset', async () => {
  const fileBuf = readFileSync(DEMO_GZ);
  const ab = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
  const geojson = await parseGzippedGeoJSON(ab);
  assert.equal(geojson.type, 'FeatureCollection');
  assert.ok(geojson.features.length > 1000);
  const processed = processGeoJSON(geojson, 'demo-november-pins');
  assert.ok(processed.features[0].properties._uid);
});

test('calculateScore weights dimensions onto 0–100', () => {
  assert.equal(calculateScore(getDefaultScoreInputs(), DEFAULT_SCORING_WEIGHTS), 50);
  assert.equal(calculateScore({
    accessibility: 10,
    competition: 10,
    demand: 10,
    visibility: 10,
    infrastructure: 10,
  }), 100);
  assert.equal(calculateScore({
    accessibility: 0,
    competition: 0,
    demand: 0,
    visibility: 0,
    infrastructure: 0,
  }), 0);
  // Accessibility-heavy input should beat a demand-only high score under defaults
  // (0.25 vs 0.25 equal — use visibility which is lower weight).
  const highAccess = calculateScore({
    accessibility: 10, competition: 0, demand: 0, visibility: 0, infrastructure: 0,
  });
  const highVis = calculateScore({
    accessibility: 0, competition: 0, demand: 0, visibility: 10, infrastructure: 0,
  });
  assert.ok(highAccess > highVis);
});

test('normalizeScoreInputs clamps and fills defaults', () => {
  assert.deepEqual(normalizeScoreInputs({ accessibility: 12, competition: -2 }), {
    accessibility: 10,
    competition: 0,
    demand: 5,
    visibility: 5,
    infrastructure: 5,
  });
});

test('createScoredSite / sort / filter helpers', () => {
  const a = createScoredSite({
    uid: '1',
    name: 'A',
    layerId: 'L',
    metadata: {
      status: 'shortlisted',
      dev_score_inputs: {
        accessibility: 9, competition: 8, demand: 9, visibility: 8, infrastructure: 8,
      },
    },
  });
  const b = createScoredSite({
    uid: '2',
    name: 'B',
    layerId: 'L',
    metadata: { status: 'lead', dev_score_inputs: getDefaultScoreInputs() },
  });
  assert.equal(a.status, 'shortlisted');
  assert.ok(a.score > b.score);
  assert.deepEqual(sortSitesByScore([b, a]).map((s) => s.uid), ['1', '2']);
  assert.deepEqual(filterSitesByStatus([a, b], ['lead']).map((s) => s.uid), ['2']);
});
