/**
 * Web Worker: KMZ/KML/GeoJSON → FeatureCollection off the main thread.
 * Uses JSZip + @tmcw/togeojson + @xmldom/xmldom (no browser DOMParser in workers).
 */
import JSZip from 'jszip';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';

function hashString(str) {
  let hash = 0;
  const text = String(str || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function generateFeatureUID(feature, layerId, index) {
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

function processGeoJSON(geojson, layerId) {
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

function parseKmlString(kmlString) {
  const doc = new DOMParser().parseFromString(kmlString, 'text/xml');
  const err = doc.getElementsByTagName?.('parsererror')?.[0];
  if (err) throw new Error('Invalid KML format');
  return kmlToGeoJSON(doc);
}

async function extractKmlFromKmz(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const kmlFile = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.kml'));
  if (!kmlFile) throw new Error('No KML file found in KMZ archive');
  return zip.files[kmlFile].async('string');
}

self.onmessage = async (event) => {
  const { id, buffer, filename, layerId } = event.data || {};
  try {
    self.postMessage({ id, type: 'progress', phase: 'parsing', ratio: 0.05 });
    const extension = String(filename || '').toLowerCase().split('.').pop();
    let raw;
    if (extension === 'kmz') {
      self.postMessage({ id, type: 'progress', phase: 'unzip', ratio: 0.15 });
      const kml = await extractKmlFromKmz(buffer);
      self.postMessage({ id, type: 'progress', phase: 'kml', ratio: 0.45 });
      raw = parseKmlString(kml);
    } else if (extension === 'kml') {
      const text = new TextDecoder().decode(buffer);
      self.postMessage({ id, type: 'progress', phase: 'kml', ratio: 0.45 });
      raw = parseKmlString(text);
    } else if (extension === 'geojson' || extension === 'json') {
      const text = new TextDecoder().decode(buffer);
      raw = JSON.parse(text);
    } else {
      throw new Error(`Unsupported file type: ${extension}`);
    }
    self.postMessage({ id, type: 'progress', phase: 'stamp', ratio: 0.8 });
    const geojson = processGeoJSON(raw, layerId || 'import');
    self.postMessage({
      id,
      type: 'done',
      geojson,
      featureCount: geojson.features.length,
    });
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      message: error?.message || String(error),
    });
  }
};
