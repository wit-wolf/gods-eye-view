/**
 * Property Genius Sites layer — KMZ/KML import on the Cesium photoreal globe.
 *
 * Large imports must not freeze Chrome: KMZ parse runs in a worker, Cesium
 * entities are created in idle batches, DEMO first-paint uses a Cape Town
 * preview, and enabling Sites alone does not dump ~10k features.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../data/contextStore.js';
import {
  extractKMLFromKMZ,
  getBounds,
  getGeometryTypes,
  parseGzippedGeoJSON,
  parseKML,
  processGeoJSON,
} from './importKml.js';
import { importFileInWorker } from './importWorkerBridge.js';
import { normalizeSiteStatus } from './scoring.js';
import { closeSiteCard, openSiteCard } from './siteCard.js';
import {
  DEMO_GEOJSON_GZ_URL,
  DEMO_KMZ_URL,
  DEMO_LAYER_ID,
  DEMO_LAYER_NAME,
  DEMO_PREVIEW_GEOJSON_URL,
  createLayerCatalogEntry,
  deleteLayerGeoJSON,
  ensureSiteMetadata,
  getSiteMetadata,
  loadLayerCatalog,
  loadLayerGeoJSON,
  loadSiteSettings,
  saveLayerCatalog,
  saveLayerGeoJSON,
} from './siteStore.js';
import {
  isAbortError,
  mapInBatches,
  sampleFeaturesForPreview,
  yieldToMain,
} from './yield.js';

export const SITES_LAYER_ID = 'sites';
/** First DEMO paint size before streaming the remainder. */
export const SITES_FIRST_PAINT_CAP = 500;
/** Entities created per idle batch after first paint. */
export const SITES_PAINT_BATCH = 100;

const STATUS_COLORS = {
  lead: '#f0c14a',
  screening: '#4ea1ff',
  shortlisted: '#3dd68c',
  rejected: '#ff5c5c',
};

let _viewer = null;
let _enabled = false;
let _destroyed = false;
let _dataSource = null;
let _clickHandler = null;
let _dropCleanup = null;
let _fileInput = null;
let _count = 0;
let _totalPlanned = 0;
let _lastUpdate = null;
let _error = null;
let _loading = false;
let _status = 'idle';
let _progressLabel = '';
let _rowControlsListener = null;
let _pendingAction = null;
/** @type {AbortController|null} */
let _loadAbort = null;
/** @type {Map<string, object>} */
let _featureByUid = new Map();
/** @type {object[]} */
let _catalog = [];
/** Generation token so a superseded rebuild cannot finish painting. */
let _paintGeneration = 0;

function notifyRowControls() {
  try { _rowControlsListener?.(); } catch { /* panel refresh is best-effort */ }
}

function setBusy(status, error = null, progressLabel = '') {
  _status = status;
  _loading = status === 'loading' || status === 'converting' || status === 'painting';
  _error = error;
  _progressLabel = progressLabel;
  notifyRowControls();
}

function accentForUid(uid) {
  const meta = getSiteMetadata(uid);
  const status = normalizeSiteStatus(meta?.status);
  return STATUS_COLORS[status] || STATUS_COLORS.lead;
}

function makeLayerId(filename) {
  const base = String(filename || 'import')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'import';
  return `sites-${base}-${Date.now().toString(36)}`;
}

function beginLoad() {
  if (_loadAbort) _loadAbort.abort();
  _loadAbort = new AbortController();
  _paintGeneration += 1;
  return { signal: _loadAbort.signal, generation: _paintGeneration };
}

function cancelLoad() {
  if (_loadAbort) {
    _loadAbort.abort();
    _loadAbort = null;
  }
  _paintGeneration += 1;
}

async function ensureDemoCatalogEntry() {
  _catalog = loadLayerCatalog();
  if (_catalog.some((entry) => entry.id === DEMO_LAYER_ID)) return;
  _catalog.push(createLayerCatalogEntry({
    id: DEMO_LAYER_ID,
    name: DEMO_LAYER_NAME,
    filename: 'November_Google_Earth_Pins.kmz',
    type: 'kmz',
    featureCount: 0,
    geometryTypes: ['Point', 'Polygon'],
    color: '#3dd6c6',
  }));
  saveLayerCatalog(_catalog);
}

async function loadPreviewGeoJSON() {
  const response = await fetch(DEMO_PREVIEW_GEOJSON_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  return processGeoJSON(raw, DEMO_LAYER_ID);
}

async function loadFullDemoGeoJSON(signal, onProgress) {
  onProgress?.('Fetching demo…');
  try {
    const response = await fetch(DEMO_GEOJSON_GZ_URL, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (signal?.aborted) throw abortErr();
    onProgress?.('Decompressing…');
    await yieldToMain({ signal });
    const raw = await parseGzippedGeoJSON(buffer);
    await yieldToMain({ signal });
    return processGeoJSON(raw, DEMO_LAYER_ID);
  } catch (gzError) {
    if (isAbortError(gzError)) throw gzError;
    console.warn('[Sites] gzipped demo unavailable, falling back to KMZ:', gzError);
    onProgress?.('Parsing KMZ…');
    const response = await fetch(DEMO_KMZ_URL, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const kml = await extractKMLFromKMZ(buffer);
    await yieldToMain({ signal });
    const raw = parseKML(kml);
    await yieldToMain({ signal });
    return processGeoJSON(raw, DEMO_LAYER_ID);
  }
}

function abortErr() {
  const error = new Error('Sites import cancelled');
  error.name = 'AbortError';
  return error;
}

function unwrapProperties(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(unwrapProperties);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry && typeof entry.getValue === 'function'
      ? unwrapProperties(entry.getValue(Cesium.JulianDate.now()))
      : unwrapProperties(entry);
  }
  return out;
}

function styleEntity(entity, uid) {
  const color = Cesium.Color.fromCssColorString(accentForUid(uid));
  if (entity.polygon) {
    entity.polygon.material = color.withAlpha(0.28);
    entity.polygon.outline = true;
    entity.polygon.outlineColor = color;
    entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
  }
  if (entity.polyline) {
    entity.polyline.material = color;
    entity.polyline.width = 2;
    entity.polyline.clampToGround = true;
  }
  entity.point = new Cesium.PointGraphics({
    pixelSize: 10,
    color,
    outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
    outlineWidth: 1,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
}

function featurePosition(entity) {
  let pos = entity.position?.getValue?.(Cesium.JulianDate.now());
  if (pos) return pos;
  if (entity.polygon?.hierarchy) {
    const hierarchy = entity.polygon.hierarchy.getValue(Cesium.JulianDate.now());
    if (hierarchy?.positions?.length) {
      return Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
    }
  }
  if (entity.polyline?.positions) {
    const positions = entity.polyline.positions.getValue(Cesium.JulianDate.now());
    if (positions?.length) {
      return Cesium.BoundingSphere.fromPoints(positions).center;
    }
  }
  return null;
}

function clearDataSource() {
  removeEntityContextsForLayer(SITES_LAYER_ID);
  _featureByUid = new Map();
  _count = 0;
  _totalPlanned = 0;
  if (_dataSource) {
    try {
      // Empty first so a raced add() against this collection cannot keep
      // stale ids alive after we swap the data source reference.
      _dataSource.entities.removeAll();
    } catch { /* ignore */ }
    if (_viewer) {
      try { _viewer.dataSources.remove(_dataSource, true); } catch { /* gone */ }
    }
  }
  _dataSource = null;
}

function ensureDataSource() {
  if (_dataSource) return _dataSource;
  const ds = new Cesium.CustomDataSource('Sites');
  ds.clustering.enabled = true;
  ds.clustering.pixelRange = 18;
  ds.clustering.minimumClusterSize = 4;
  ds.show = _enabled;
  _viewer.dataSources.add(ds);
  _dataSource = ds;
  return ds;
}

/**
 * Drop duplicate `_uid`s (preview∪full and duplicate KML pins share ids).
 * @param {object[]} features
 * @returns {object[]}
 */
export function dedupeFeaturesByUid(features) {
  const seen = new Set();
  const out = [];
  for (const feature of features || []) {
    const uid = feature?.properties?._uid;
    if (!uid) {
      out.push(feature);
      continue;
    }
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push(feature);
  }
  return out;
}

function hasEntityId(uid) {
  if (!uid || !_dataSource) return false;
  if (_featureByUid.has(uid)) return true;
  try {
    return Boolean(_dataSource.entities.getById(uid));
  } catch {
    return false;
  }
}

/**
 * Add one feature as a Cesium entity. Idempotent: existing ids are skipped
 * (preview→full stream, double DEMO, duplicate KML pins).
 * @returns {object|null} Entity, or null when skipped / unsupported.
 */
function addFeatureEntity(feature, index) {
  if (!_dataSource) return null;
  const props = feature.properties || {};
  const uid = props._uid || `sites:orphan:${index}`;
  const name = props._name || props.name || props.Name || `Site ${index + 1}`;
  const geom = feature.geometry;
  if (!geom) return null;

  if (hasEntityId(uid)) {
    return _featureByUid.get(uid)?.entity || _dataSource.entities.getById(uid) || null;
  }

  ensureSiteMetadata(uid, name);
  const entityOptions = {
    id: uid,
    properties: props,
  };

  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
    const [lon, lat, height = 0] = geom.coordinates;
    entityOptions.position = Cesium.Cartesian3.fromDegrees(lon, lat, height || 0);
  } else if (geom.type === 'Polygon' && geom.coordinates?.[0]) {
    const ring = geom.coordinates[0]
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
    if (ring.length >= 3) {
      entityOptions.polygon = {
        hierarchy: new Cesium.PolygonHierarchy(ring),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      };
      entityOptions.position = Cesium.BoundingSphere.fromPoints(ring).center;
    }
  } else if (geom.type === 'LineString' && geom.coordinates) {
    const positions = geom.coordinates
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
    if (positions.length >= 2) {
      entityOptions.polyline = {
        positions,
        clampToGround: true,
        width: 2,
      };
      entityOptions.position = Cesium.BoundingSphere.fromPoints(positions).center;
    }
  } else {
    // Skip GeometryCollection / Multi* for progressive path simplicity;
    // preview + demo gz are Point/Polygon only.
    return null;
  }

  if (!entityOptions.position && !entityOptions.polygon && !entityOptions.polyline) {
    return null;
  }

  let entity;
  try {
    entity = _dataSource.entities.add(entityOptions);
  } catch (error) {
    // Cesium throws if the id raced in between hasEntityId and add().
    const message = String(error?.message || error || '');
    if (/already exists/i.test(message)) {
      console.warn(`[Sites] skip duplicate entity id: ${uid}`);
      return _dataSource.entities.getById(uid) || null;
    }
    console.warn(`[Sites] entity add failed for ${uid}:`, error);
    return null;
  }

  entity.__sitesLayerId = SITES_LAYER_ID;
  entity.__siteUid = uid;
  styleEntity(entity, uid);

  const pos = featurePosition(entity);
  let latitude = null;
  let longitude = null;
  if (pos) {
    const carto = Cesium.Cartographic.fromCartesian(pos);
    latitude = Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6));
    longitude = Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6));
  }

  _featureByUid.set(uid, { entity, props, name });
  registerEntityContext(entity, {
    id: `${SITES_LAYER_ID}:${uid}`,
    layerId: SITES_LAYER_ID,
    layerName: 'Sites',
    source: 'Property Genius',
    dataSource: _dataSource,
    label: name,
    properties: props,
    latitude,
    longitude,
  });
  return entity;
}

/**
 * Paint features in batches. First `firstPaint` entities land ASAP; the rest
 * stream during idle time.
 * @param {object[]} features
 * @param {object} options
 */
async function paintFeatures(features, {
  signal,
  generation,
  firstPaint = SITES_FIRST_PAINT_CAP,
  batchSize = SITES_PAINT_BATCH,
} = {}) {
  if (!_viewer || _destroyed) return;
  const list = dedupeFeaturesByUid(Array.isArray(features) ? features : []);
  _totalPlanned = list.length;
  ensureDataSource();
  _dataSource.show = _enabled;

  const immediate = list.slice(0, firstPaint);
  const remainder = list.slice(firstPaint);

  setBusy('painting', null, `Painting ${Math.min(immediate.length, list.length)}/${list.length}…`);
  await mapInBatches(immediate, {
    batchSize,
    signal,
    work: async (batch, startIndex) => {
      if (generation !== _paintGeneration) throw abortErr();
      for (let i = 0; i < batch.length; i++) {
        if (generation !== _paintGeneration) throw abortErr();
        addFeatureEntity(batch[i], startIndex + i);
      }
      _count = _featureByUid.size;
    },
    onProgress: ({ done }) => {
      if (generation !== _paintGeneration) return;
      _count = _featureByUid.size;
      setBusy('painting', null, `Painting ${done}/${list.length}…`);
      governorRequestRender('sites:first-paint');
    },
  });
  _count = _featureByUid.size;
  _lastUpdate = Date.now();
  notifyRowControls();
  governorRequestRender('sites:first-paint');
  await yieldToMain({ signal });

  if (!remainder.length) {
    setBusy(_count ? 'nominal' : 'empty');
    return;
  }

  await mapInBatches(remainder, {
    batchSize,
    signal,
    onProgress: ({ done, total }) => {
      if (generation !== _paintGeneration) return;
      _count = _featureByUid.size;
      setBusy(
        'painting',
        null,
        `Painting ${Math.min(firstPaint + done, list.length)}/${list.length}…`,
      );
      governorRequestRender('sites:paint-batch');
    },
    work: async (batch, startIndex) => {
      if (generation !== _paintGeneration) throw abortErr();
      for (let i = 0; i < batch.length; i++) {
        if (generation !== _paintGeneration) throw abortErr();
        addFeatureEntity(batch[i], firstPaint + startIndex + i);
      }
      _count = _featureByUid.size;
    },
  });

  if (generation !== _paintGeneration) return;
  _count = _featureByUid.size;
  _lastUpdate = Date.now();
  setBusy(_count ? 'nominal' : 'empty');
  governorRequestRender('sites:paint-done');
}

async function loadCachedOrPromptEmpty() {
  // Enabling Sites alone must stay instant. Only paint layers already cached
  // in IndexedDB from a prior DEMO/IMPORT — never auto-fetch the November dump.
  _catalog = loadLayerCatalog();
  const collections = [];
  for (const entry of _catalog) {
    if (entry.visible === false) continue;
    const geojson = await loadLayerGeoJSON(entry.id).catch(() => null);
    if (geojson?.features?.length) collections.push(geojson);
  }
  if (!collections.length) {
    _count = 0;
    _totalPlanned = 0;
    setBusy('empty', null, 'Click DEMO or IMPORT');
    return;
  }
  const features = collections.flatMap((c) => c.features || []);
  const { signal, generation } = beginLoad();
  clearDataSource();
  try {
    await paintFeatures(features, { signal, generation });
  } catch (error) {
    if (isAbortError(error)) return;
    console.error('[Sites] cached paint failed:', error);
    setBusy('unavailable', error?.message || 'dataset unavailable');
  }
}

function selectSiteEntity(entity) {
  if (!entity?.__siteUid) return;
  const uid = entity.__siteUid;
  const record = _featureByUid.get(uid);
  const props = record?.props || unwrapProperties(
    entity.properties?.getValue?.(Cesium.JulianDate.now()) || {},
  );
  const name = record?.name || props._name || 'Site';

  _viewer.selectedEntity = entity;
  selectEntityContext(entity);

  openSiteCard({
    uid,
    name,
    properties: props,
    onChange: () => {
      styleEntity(entity, uid);
      governorRequestRender('sites:restyle');
    },
  });

  const pos = featurePosition(entity);
  if (pos) {
    const carto = Cesium.Cartographic.fromCartesian(pos);
    _viewer.scene.screenSpaceCameraController.enableInputs = false;
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 4500),
      duration: 1.2,
      complete: () => { _viewer.scene.screenSpaceCameraController.enableInputs = true; },
      cancel: () => { _viewer.scene.screenSpaceCameraController.enableInputs = true; },
    });
  }
}

function installClickHandler() {
  if (_clickHandler || !_viewer) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!_enabled) return;
    const picked = _viewer.scene.pick(click.position);
    const entity = picked?.id;
    if (entity && entity.__sitesLayerId === SITES_LAYER_ID) {
      selectSiteEntity(entity);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function ensureFileInput() {
  if (_fileInput || typeof document === 'undefined') return _fileInput;
  _fileInput = document.createElement('input');
  _fileInput.type = 'file';
  _fileInput.accept = '.kmz,.kml,.geojson,.json,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,application/geo+json';
  _fileInput.hidden = true;
  _fileInput.addEventListener('change', async () => {
    const file = _fileInput.files?.[0];
    _fileInput.value = '';
    if (file) await importUserFile(file);
  });
  document.body.appendChild(_fileInput);
  return _fileInput;
}

function installDropTarget() {
  if (_dropCleanup || typeof document === 'undefined') return;
  const onDragOver = (event) => {
    if (!_enabled) return;
    const types = event.dataTransfer?.types;
    if (!types || ![...types].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (event) => {
    if (!_enabled) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const name = file.name?.toLowerCase?.() || '';
    if (!/\.(kmz|kml|geojson|json)$/.test(name)) return;
    event.preventDefault();
    event.stopPropagation();
    await importUserFile(file);
  };
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  _dropCleanup = () => {
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('drop', onDrop);
    _dropCleanup = null;
  };
}

async function importUserFile(file) {
  if (_destroyed) return;
  const { signal, generation } = beginLoad();
  setBusy('converting', null, `Importing ${file.name}…`);
  try {
    const layerId = makeLayerId(file.name);
    const buffer = await file.arrayBuffer();
    if (signal.aborted) throw abortErr();
    const geojson = await importFileInWorker({
      buffer,
      filename: file.name,
      layerId,
      signal,
      onProgress: ({ phase, ratio }) => {
        setBusy('converting', null, `${phase} ${Math.round((ratio || 0) * 100)}%`);
      },
    });
    if (!geojson.features.length) throw new Error('No features found in file');

    // Persist off the critical path after first paint starts.
    queueMicrotask(() => {
      void saveLayerGeoJSON(layerId, geojson).catch((err) => {
        console.warn('[Sites] IndexedDB cache failed:', err);
      });
    });
    _catalog = loadLayerCatalog().filter((entry) => entry.id !== layerId);
    _catalog.push(createLayerCatalogEntry({
      id: layerId,
      name: file.name.replace(/\.[^.]+$/, ''),
      filename: file.name,
      type: (file.name.split('.').pop() || 'kml').toLowerCase(),
      featureCount: geojson.features.length,
      geometryTypes: getGeometryTypes(geojson),
    }));
    saveLayerCatalog(_catalog);

    if (!_enabled) {
      setBusy('idle');
      return;
    }
    clearDataSource();
    const ordered = [];
    const seen = new Set();
    for (const feature of sampleFeaturesForPreview(geojson.features, SITES_FIRST_PAINT_CAP)) {
      ordered.push(feature);
      seen.add(feature);
    }
    for (const feature of geojson.features) {
      if (!seen.has(feature)) ordered.push(feature);
    }
    await paintFeatures(ordered, { signal, generation });
    flyToCurrentFeatures({ type: 'FeatureCollection', features: ordered.slice(0, SITES_FIRST_PAINT_CAP) });
  } catch (error) {
    if (isAbortError(error)) {
      setBusy(_count ? 'nominal' : 'empty', null, 'Cancelled');
      return;
    }
    console.error('[Sites] import failed:', error);
    setBusy(_count ? 'degraded' : 'unavailable', error?.message || 'import failed');
  }
}

function flyToCurrentFeatures(geojson = null) {
  if (!_viewer) return;
  let bounds = geojson ? getBounds(geojson) : null;
  if (!bounds && _featureByUid.size) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const { entity } of _featureByUid.values()) {
      const pos = featurePosition(entity);
      if (!pos) continue;
      const carto = Cesium.Cartographic.fromCartesian(pos);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    if (Number.isFinite(west)) bounds = [[west, south], [east, north]];
  }
  if (!bounds) return;
  const [[west, south], [east, north]] = bounds;
  const rectangle = Cesium.Rectangle.fromDegrees(
    west - 0.05,
    south - 0.05,
    east + 0.05,
    north + 0.05,
  );
  _viewer.camera.flyTo({ destination: rectangle, duration: 1.6 });
}

async function runDemoLoad() {
  const { signal, generation } = beginLoad();
  setBusy('loading', null, 'Loading Cape Town preview…');
  try {
    await ensureDemoCatalogEntry();
    const preview = await loadPreviewGeoJSON();
    if (signal.aborted) throw abortErr();

    clearDataSource();
    await paintFeatures(preview.features, {
      signal,
      generation,
      firstPaint: preview.features.length,
    });
    flyToCurrentFeatures(preview);

    // Stream the full gzipped set in the background.
    setBusy('loading', null, 'Streaming full demo…');
    const full = await loadFullDemoGeoJSON(signal, (label) => {
      setBusy('loading', null, label);
    });
    if (signal.aborted || generation !== _paintGeneration) throw abortErr();

    queueMicrotask(() => {
      void saveLayerGeoJSON(DEMO_LAYER_ID, full).catch(() => {});
    });
    _catalog = loadLayerCatalog();
    const demo = _catalog.find((entry) => entry.id === DEMO_LAYER_ID);
    if (demo) {
      demo.feature_count = full.features.length;
      demo.geometry_types = getGeometryTypes(full);
      demo.visible = true;
      saveLayerCatalog(_catalog);
    }

    // Append features not already drawn (preview∪full share stable _uids).
    const extra = dedupeFeaturesByUid(full.features).filter((f) => {
      const uid = f.properties?._uid;
      return uid && !hasEntityId(uid);
    });
    if (extra.length) {
      _totalPlanned = _count + extra.length;
      setBusy('painting', null, `Painting ${_count}/${_totalPlanned}…`);
      await mapInBatches(extra, {
        batchSize: SITES_PAINT_BATCH,
        signal,
        work: async (batch) => {
          if (generation !== _paintGeneration) throw abortErr();
          for (const feature of batch) {
            if (generation !== _paintGeneration) throw abortErr();
            addFeatureEntity(feature, _featureByUid.size);
          }
          _count = _featureByUid.size;
        },
        onProgress: () => {
          if (generation !== _paintGeneration) return;
          _count = _featureByUid.size;
          setBusy('painting', null, `Painting ${_count}/${_totalPlanned}…`);
          governorRequestRender('sites:paint-batch');
        },
      });
    }
    if (generation !== _paintGeneration) return;
    _count = _featureByUid.size;
    _lastUpdate = Date.now();
    setBusy(_count ? 'nominal' : 'empty');
    notifyRowControls();
    governorRequestRender('sites:demo-done');
  } catch (error) {
    if (isAbortError(error)) {
      setBusy(_count ? 'nominal' : 'empty', null, 'Cancelled');
      return;
    }
    console.error('[Sites] demo load failed:', error);
    setBusy('unavailable', error?.message || 'demo load failed');
  }
}

async function clearImportedLayers() {
  cancelLoad();
  _catalog = loadLayerCatalog();
  for (const entry of _catalog) {
    try { await deleteLayerGeoJSON(entry.id); } catch { /* ignore */ }
  }
  _catalog = [];
  saveLayerCatalog(_catalog);
  clearDataSource();
  closeSiteCard();
  setBusy('empty', null, 'Click DEMO or IMPORT');
}

async function handlePendingAction() {
  const action = _pendingAction;
  _pendingAction = null;
  if (!action) return;
  if (action === 'import') {
    ensureFileInput()?.click();
    return;
  }
  if (action === 'demo') {
    await runDemoLoad();
    return;
  }
  if (action === 'clear') {
    await clearImportedLayers();
    return;
  }
  if (action === 'cancel') {
    cancelLoad();
    setBusy(_count ? 'nominal' : 'empty', null, 'Cancelled');
    return;
  }
  if (action === 'fly') {
    flyToCurrentFeatures();
  }
}

const sitesLayer = {
  id: SITES_LAYER_ID,
  name: 'Sites',
  icon: '◇',
  source: 'Property Genius',
  updateInterval: 0,
  statsRefreshInterval: 1000,

  async init(viewer) {
    _viewer = viewer;
    _catalog = loadLayerCatalog();
  },

  async update() {},

  getStats() {
    const settings = loadSiteSettings();
    return {
      count: _count,
      totalPlanned: _totalPlanned,
      lastUpdate: _lastUpdate,
      error: _error,
      loading: _loading,
      status: _status,
      source: _progressLabel
        ? `Property Genius · ${_progressLabel}`
        : 'Property Genius · local',
      scoringWeights: settings.scoring_weights,
    };
  },

  getRowControls() {
    const busy = _loading;
    const chips = [
      {
        id: 'sites-import',
        label: 'IMPORT',
        title: 'Import KMZ / KML / GeoJSON (background parse)',
        active: false,
        disabled: false,
        params: { sitesAction: 'import' },
      },
      {
        id: 'sites-demo',
        label: busy && _status !== 'idle' ? 'LOADING' : 'DEMO',
        title: 'Load November pins — Cape Town preview first, then stream the rest',
        active: false,
        disabled: busy,
        busy,
        state: busy ? 'loading' : 'idle',
        params: { sitesAction: 'demo' },
      },
      {
        id: 'sites-fly',
        label: 'FLY',
        title: 'Fly to imported sites',
        active: false,
        disabled: busy || _count === 0,
        params: { sitesAction: 'fly' },
      },
      {
        id: 'sites-clear',
        label: 'RESET',
        title: 'Clear sites from the globe and local cache',
        active: false,
        disabled: false,
        params: { sitesAction: 'clear' },
      },
    ];
    if (busy) {
      chips.splice(1, 0, {
        id: 'sites-cancel',
        label: 'CANCEL',
        title: 'Cancel the current import / demo load',
        active: false,
        disabled: false,
        params: { sitesAction: 'cancel' },
      });
    }
    return {
      chips,
      legend: [
        { color: STATUS_COLORS.lead, label: 'Lead', count: '' },
        { color: STATUS_COLORS.screening, label: 'Screening', count: '' },
        { color: STATUS_COLORS.shortlisted, label: 'Shortlisted', count: '' },
        { color: STATUS_COLORS.rejected, label: 'Rejected', count: '' },
      ],
    };
  },

  setRowControlsListener(listener) {
    _rowControlsListener = typeof listener === 'function' ? listener : null;
  },

  setParams(next = {}) {
    if (next.sitesAction) {
      _pendingAction = next.sitesAction;
      queueMicrotask(() => { void handlePendingAction(); });
    }
    return true;
  },

  getParams() {
    return { sitesAction: null };
  },

  async enable(viewer) {
    if (_destroyed) return;
    _viewer = viewer || _viewer;
    _enabled = true;
    installClickHandler();
    installDropTarget();
    ensureFileInput();
    if (_dataSource) {
      _dataSource.show = true;
      setBusy(_count ? 'nominal' : 'empty', null, _count ? '' : 'Click DEMO or IMPORT');
    } else {
      await loadCachedOrPromptEmpty();
    }
    governorRequestRender('sites:enable');
  },

  disable() {
    _enabled = false;
    cancelLoad();
    if (_dataSource) _dataSource.show = false;
    clearSelectedEntityContextForLayer(SITES_LAYER_ID);
    closeSiteCard();
    if (_viewer?.selectedEntity?.__sitesLayerId === SITES_LAYER_ID) {
      _viewer.selectedEntity = undefined;
    }
    setBusy('idle');
  },

  destroy(viewer) {
    if (_destroyed) return;
    _destroyed = true;
    this.disable();
    _dropCleanup?.();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_fileInput) {
      _fileInput.remove();
      _fileInput = null;
    }
    clearDataSource();
    if (_dataSource && (viewer || _viewer)) {
      try { (viewer || _viewer).dataSources.remove(_dataSource, true); } catch { /* ignore */ }
    }
    _viewer = null;
  },
};

export default sitesLayer;

/** Test helpers */
export function _resetSitesLayerForTest() {
  cancelLoad();
  _viewer = null;
  _enabled = false;
  _destroyed = false;
  _dataSource = null;
  _clickHandler = null;
  _dropCleanup = null;
  _fileInput = null;
  _count = 0;
  _totalPlanned = 0;
  _lastUpdate = null;
  _error = null;
  _loading = false;
  _status = 'idle';
  _progressLabel = '';
  _rowControlsListener = null;
  _pendingAction = null;
  _featureByUid = new Map();
  _catalog = [];
  _paintGeneration = 0;
}
