/**
 * Local persistence for Property Genius site metadata + imported layer catalog.
 * Metadata → localStorage. Large GeoJSON → IndexedDB (not Azure SQL for this PR).
 */

import {
  DEFAULT_SCORING_WEIGHTS,
  getDefaultScoreInputs,
  normalizeScoreInputs,
  normalizeSiteStatus,
} from './scoring.js';

export const SITE_METADATA_STORAGE_KEY = 'gev:sites:metadata:v1';
export const SITE_LAYERS_STORAGE_KEY = 'gev:sites:layers:v1';
export const SITE_SETTINGS_STORAGE_KEY = 'gev:sites:settings:v1';
export const SITE_IDB_NAME = 'gev-sites';
export const SITE_IDB_STORE = 'geojson';
export const SITE_IDB_VERSION = 1;

export const DEMO_LAYER_ID = 'demo-november-pins';
export const DEMO_LAYER_NAME = 'November Google Earth Pins';
export const DEMO_KMZ_URL = '/sites/November_Google_Earth_Pins.kmz';
export const DEMO_GEOJSON_GZ_URL = '/sites/november_pins.geojson.gz';
export const DEMO_PREVIEW_GEOJSON_URL = '/sites/november_pins.preview.geojson';

function nowIso() {
  return new Date().toISOString();
}

function canUseLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage != null;
  } catch {
    return false;
  }
}

function readJson(key, fallback) {
  if (!canUseLocalStorage()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('[Sites] localStorage write failed:', error);
    return false;
  }
}

/**
 * @returns {Record<string, object>}
 */
export function loadSiteMetadataMap() {
  const raw = readJson(SITE_METADATA_STORAGE_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * @param {Record<string, object>} map
 */
export function saveSiteMetadataMap(map) {
  return writeJson(SITE_METADATA_STORAGE_KEY, map || {});
}

/**
 * @param {string} uid
 * @returns {object|null}
 */
export function getSiteMetadata(uid) {
  if (!uid) return null;
  const map = loadSiteMetadataMap();
  return map[uid] || null;
}

/**
 * Upsert one site metadata record (status, notes, scores).
 * @param {string} uid
 * @param {object} patch
 * @returns {object}
 */
export function upsertSiteMetadata(uid, patch = {}) {
  const map = loadSiteMetadataMap();
  const existing = map[uid] || null;
  const createdAt = existing?.created_at || nowIso();
  const record = {
    feature_uid: uid,
    site_name: patch.site_name ?? existing?.site_name,
    notes: patch.notes ?? existing?.notes ?? '',
    status: normalizeSiteStatus(patch.status ?? existing?.status ?? 'lead'),
    category: patch.category ?? existing?.category ?? 'retail',
    zoning_code: patch.zoning_code ?? existing?.zoning_code,
    zoning_source: patch.zoning_source ?? existing?.zoning_source,
    zoning_confidence: patch.zoning_confidence ?? existing?.zoning_confidence,
    dev_score_inputs: normalizeScoreInputs(
      patch.dev_score_inputs ?? existing?.dev_score_inputs ?? getDefaultScoreInputs(),
    ),
    created_at: createdAt,
    updated_at: nowIso(),
  };
  map[uid] = record;
  saveSiteMetadataMap(map);
  return record;
}

/**
 * Ensure a metadata shell exists for a newly imported feature.
 * @param {string} uid
 * @param {string} [name]
 * @returns {object}
 */
export function ensureSiteMetadata(uid, name) {
  const existing = getSiteMetadata(uid);
  if (existing) return existing;
  return upsertSiteMetadata(uid, {
    site_name: name,
    status: 'lead',
    notes: '',
    dev_score_inputs: getDefaultScoreInputs(),
  });
}

/**
 * @returns {object[]}
 */
export function loadLayerCatalog() {
  const raw = readJson(SITE_LAYERS_STORAGE_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * @param {object[]} layers
 */
export function saveLayerCatalog(layers) {
  return writeJson(SITE_LAYERS_STORAGE_KEY, layers || []);
}

/**
 * @returns {{scoring_weights: object}}
 */
export function loadSiteSettings() {
  const raw = readJson(SITE_SETTINGS_STORAGE_KEY, null);
  return {
    scoring_weights: {
      ...DEFAULT_SCORING_WEIGHTS,
      ...(raw?.scoring_weights || {}),
    },
  };
}

/**
 * @param {object} settings
 */
export function saveSiteSettings(settings) {
  return writeJson(SITE_SETTINGS_STORAGE_KEY, settings || { scoring_weights: DEFAULT_SCORING_WEIGHTS });
}

function openIdb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SITE_IDB_NAME, SITE_IDB_VERSION);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SITE_IDB_STORE)) {
        db.createObjectStore(SITE_IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Persist a FeatureCollection for an imported layer.
 * @param {string} layerId
 * @param {GeoJSON.FeatureCollection} geojson
 */
export async function saveLayerGeoJSON(layerId, geojson) {
  const db = await openIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SITE_IDB_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.objectStore(SITE_IDB_STORE).put(geojson, layerId);
    });
  } finally {
    db.close();
  }
}

/**
 * @param {string} layerId
 * @returns {Promise<GeoJSON.FeatureCollection|null>}
 */
export async function loadLayerGeoJSON(layerId) {
  const db = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SITE_IDB_STORE, 'readonly');
      const request = tx.objectStore(SITE_IDB_STORE).get(layerId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
    });
  } finally {
    db.close();
  }
}

/**
 * @param {string} layerId
 */
export async function deleteLayerGeoJSON(layerId) {
  const db = await openIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SITE_IDB_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
      tx.objectStore(SITE_IDB_STORE).delete(layerId);
    });
  } finally {
    db.close();
  }
}

/**
 * Build a catalog entry for a newly imported file.
 * @param {object} options
 * @returns {object}
 */
export function createLayerCatalogEntry({
  id,
  name,
  filename,
  type,
  featureCount,
  geometryTypes,
  color = '#3dd6c6',
}) {
  return {
    id,
    name,
    filename,
    type,
    feature_count: featureCount,
    geometry_types: geometryTypes || [],
    visible: true,
    color,
    created_at: nowIso(),
  };
}
