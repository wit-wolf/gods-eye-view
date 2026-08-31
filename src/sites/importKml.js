/**
 * KMZ/KML → GeoJSON conversion (ported from Property Genius importKml.ts).
 * Uses JSZip + @tmcw/togeojson. DOMParser is injectable for Node tests.
 */
import JSZip from 'jszip';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';

/**
 * Stable feature UID for metadata persistence across reloads.
 * @param {object} feature GeoJSON feature.
 * @param {string} layerId Owning layer id.
 * @param {number} index Feature index in the collection.
 * @returns {string}
 */
export function generateFeatureUID(feature, layerId, index) {
  if (feature?.id !== undefined && feature?.id !== null) {
    return `${layerId}:${feature.id}`;
  }

  const name = feature?.properties?.name
    || feature?.properties?.Name
    || feature?.properties?._name
    || '';
  if (name) {
    const geomHash = hashString(JSON.stringify(feature.geometry).substring(0, 200));
    return `${layerId}:${name}:${geomHash}`;
  }

  const propsHash = hashString(JSON.stringify(feature.properties || {}));
  const geomHash = hashString(JSON.stringify(feature.geometry));
  return `${layerId}:${propsHash}:${geomHash}:${index}`;
}

function hashString(str) {
  let hash = 0;
  const text = String(str || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Extract the first .kml entry from a KMZ (ZIP) ArrayBuffer.
 * @param {ArrayBuffer} buffer KMZ bytes.
 * @returns {Promise<string>} KML text.
 */
export async function extractKMLFromKMZ(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const kmlFile = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.kml'));
  if (!kmlFile) throw new Error('No KML file found in KMZ archive');
  return zip.files[kmlFile].async('string');
}

/**
 * Parse a KML string into a GeoJSON FeatureCollection.
 * @param {string} kmlString Raw KML.
 * @param {object} [options]
 * @param {typeof DOMParser} [options.DOMParser] Parser (browser global or @xmldom/xmldom).
 * @returns {GeoJSON.FeatureCollection}
 */
export function parseKML(kmlString, { DOMParser: Parser = globalThis.DOMParser } = {}) {
  if (typeof Parser !== 'function') {
    throw new Error('DOMParser is required to parse KML');
  }
  const parser = new Parser();
  const kmlDoc = parser.parseFromString(kmlString, 'text/xml');
  const parseError = typeof kmlDoc.querySelector === 'function'
    ? kmlDoc.querySelector('parsererror')
    : kmlDoc.getElementsByTagName?.('parsererror')?.[0];
  if (parseError) throw new Error('Invalid KML format');
  return kmlToGeoJSON(kmlDoc);
}

/**
 * Stamp `_uid`, `_layerId`, and `_name` onto each feature.
 * @param {GeoJSON.FeatureCollection} geojson Input collection.
 * @param {string} layerId Owning import id.
 * @returns {GeoJSON.FeatureCollection}
 */
export function processGeoJSON(geojson, layerId) {
  const features = (geojson?.features || [])
    .filter((f) => f?.geometry != null)
    .map((feature, index) => {
      const uid = generateFeatureUID(feature, layerId, index);
      const name = feature.properties?.name
        || feature.properties?.Name
        || feature.properties?.title
        || feature.properties?._name
        || `Feature ${index + 1}`;
      return {
        ...feature,
        properties: {
          ...(feature.properties || {}),
          _uid: uid,
          _layerId: layerId,
          _name: String(name),
        },
      };
    });
  return { type: 'FeatureCollection', features };
}

/**
 * Geometry type names present in a collection.
 * @param {GeoJSON.FeatureCollection} geojson
 * @returns {string[]}
 */
export function getGeometryTypes(geojson) {
  const types = new Set();
  for (const feature of geojson?.features || []) {
    if (feature?.geometry?.type) types.add(feature.geometry.type);
  }
  return [...types];
}

/**
 * Axis-aligned lon/lat bounds without turf.
 * @param {GeoJSON.FeatureCollection} geojson
 * @returns {[[number, number], [number, number]]|null} [[west,south],[east,north]]
 */
export function getBounds(geojson) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let found = false;

  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const lon = coords[0];
      const lat = coords[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      found = true;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const entry of coords) visit(entry);
  };

  for (const feature of geojson?.features || []) {
    if (feature?.geometry?.coordinates) visit(feature.geometry.coordinates);
    if (feature?.geometry?.type === 'GeometryCollection') {
      for (const geom of feature.geometry.geometries || []) {
        if (geom?.coordinates) visit(geom.coordinates);
      }
    }
  }

  if (!found) return null;
  return [[west, south], [east, north]];
}

/**
 * Read a File into KML text (or GeoJSON text for .geojson/.json).
 * @param {File|Blob} file
 * @param {string} [filename]
 * @returns {Promise<{kmlContent:string, isKmz:boolean, extension:string}>}
 */
export async function importFile(file, filename = file?.name || '') {
  const extension = String(filename).toLowerCase().split('.').pop();
  if (extension === 'kmz') {
    const buffer = await file.arrayBuffer();
    const kmlContent = await extractKMLFromKMZ(buffer);
    return { kmlContent, isKmz: true, extension };
  }
  if (extension === 'kml' || extension === 'geojson' || extension === 'json') {
    const kmlContent = await file.text();
    return { kmlContent, isKmz: false, extension };
  }
  throw new Error(`Unsupported file type: ${extension}`);
}

/**
 * Parse file content (KML or GeoJSON) into a FeatureCollection.
 * @param {string} content
 * @param {string} filename
 * @param {object} [parseOptions] Forwarded to parseKML.
 * @returns {GeoJSON.FeatureCollection}
 */
export function parseFileContent(content, filename, parseOptions = {}) {
  const extension = String(filename).toLowerCase().split('.').pop();
  if (extension === 'geojson' || extension === 'json') {
    return JSON.parse(content);
  }
  return parseKML(content, parseOptions);
}

/**
 * End-to-end: File → processed FeatureCollection.
 * @param {File|Blob} file
 * @param {string} layerId
 * @param {object} [parseOptions]
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function importAndProcessFile(file, layerId, parseOptions = {}) {
  const filename = file?.name || 'import.kml';
  const { kmlContent, extension } = await importFile(file, filename);
  const effectiveName = extension === 'kmz' ? filename.replace(/\.kmz$/i, '.kml') : filename;
  const raw = parseFileContent(kmlContent, effectiveName, parseOptions);
  return processGeoJSON(raw, layerId);
}

/**
 * Decode a gzipped GeoJSON ArrayBuffer (demo bundle).
 * Uses the Web DecompressionStream API (available in modern browsers and Node 24+).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function parseGzippedGeoJSON(buffer) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Gzipped GeoJSON requires DecompressionStream');
  }
  const stream = new Response(buffer).body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}
