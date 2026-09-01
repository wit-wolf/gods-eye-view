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
  getContextStore,
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
import { closeSiteCard, openSiteCard, setSiteCardDeleteListener, setSiteCardNameChangeListener, SITES_PIN_COLOR } from './siteCard.js';
import {
  buildSitesClusterBubbleDataUrl,
  sitesClusterBubbleSize,
} from './sitesClusterStyle.js';
import {
  SITES_FIRST_PAINT_CAP_DEFAULT,
  SITES_PAINT_BATCH_DEFAULT,
  clusterParamsForHeight,
  isPerformanceFastPreset,
  onPerformanceFastChange,
  prioritizeFeaturesNear,
  sitesPaintBatchSize,
  sitesPaintYieldMs,
} from './sitesPerformance.js';
import {
  DEMO_GEOJSON_GZ_URL,
  DEMO_KMZ_URL,
  DEMO_LAYER_ID,
  DEMO_LAYER_NAME,
  DEMO_PREVIEW_GEOJSON_URL,
  DROPPED_PINS_LAYER_ID,
  DROPPED_PINS_LAYER_NAME,
  createLayerCatalogEntry,
  deleteLayerGeoJSON,
  deleteSiteMetadata,
  ensureSiteMetadata,
  loadLayerCatalog,
  loadLayerGeoJSON,
  saveLayerCatalog,
  saveLayerGeoJSON,
  upsertSiteMetadata,
} from './siteStore.js';
import {
  isAbortError,
  mapInBatches,
  sampleFeaturesForPreview,
  yieldToMain,
} from './yield.js';

export const SITES_LAYER_ID = 'sites';
/** First DEMO/import paint size before streaming the remainder. */
export const SITES_FIRST_PAINT_CAP = SITES_FIRST_PAINT_CAP_DEFAULT;
/** Entities created per idle batch after first paint (gentler default). */
export const SITES_PAINT_BATCH = SITES_PAINT_BATCH_DEFAULT;

const SITES_COLOR = SITES_PIN_COLOR;
/** Dark teal fill for cluster discs — white count stays readable. */
const SITES_CLUSTER_FILL = '#145c56';
const SITES_CLUSTER_OUTLINE = SITES_PIN_COLOR;
const SITES_CLUSTER_TEXT = '#f2fffc';

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
/** @type {(() => void)|null} */
let _removeClusterListener = null;
/** Hand-drop place mode (PIN chip). */
let _placeMode = false;
/** @type {((event: KeyboardEvent) => void)|null} */
let _placeModeKeyHandler = null;
/** @type {HTMLElement|null} */
let _placeHint = null;
/** @type {(() => void)|null} */
let _removeCameraLod = null;
/** @type {(() => void)|null} */
let _unsubFastPreset = null;
/** Last applied cluster LOD (avoid thrashing). */
let _lastClusterLodKey = '';
/** @type {ReturnType<typeof setTimeout>|null} */
let _lodTimer = null;

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

function accentForUid() {
  return SITES_COLOR;
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

function styleEntity(entity) {
  const color = Cesium.Color.fromCssColorString(SITES_COLOR);
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
  if (_removeClusterListener) {
    try { _removeClusterListener(); } catch { /* ignore */ }
    _removeClusterListener = null;
  }
  _lastClusterLodKey = '';
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

/**
 * Style Cesium EntityCluster markers as circular count bubbles.
 * Single pins keep the teal point style from `styleEntity`.
 * Cluster density follows camera height (SA overview → clusters only).
 * @param {import('cesium').CustomDataSource} dataSource
 */
function installSitesClusterStyling(dataSource) {
  if (!dataSource?.clustering || _removeClusterListener) return;
  const clustering = dataSource.clustering;
  clustering.enabled = true;
  clustering.clusterPoints = true;
  clustering.clusterLabels = true;
  clustering.clusterBillboards = true;
  applySitesClusterLod({ force: true });

  _removeClusterListener = clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
    const count = Array.isArray(clusteredEntities) ? clusteredEntities.length : 0;
    const { diameter } = sitesClusterBubbleSize(count);
    const image = buildSitesClusterBubbleDataUrl(count, {
      fill: SITES_CLUSTER_FILL,
      outline: SITES_CLUSTER_OUTLINE,
      text: SITES_CLUSTER_TEXT,
    });

    // Hide the default bare white numeral; show a Sites-coloured disc instead.
    cluster.label.show = false;
    cluster.label.text = '';
    cluster.point.show = false;

    cluster.billboard.show = true;
    cluster.billboard.id = clusteredEntities;
    cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
    cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.billboard.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
    cluster.billboard.width = diameter;
    cluster.billboard.height = diameter;
    if (image) {
      cluster.billboard.image = image;
    } else {
      // Canvas unavailable — fall back to a filled point + small outline label
      // so we still never show a bare white floating numeral alone.
      cluster.billboard.show = false;
      cluster.point.show = true;
      cluster.point.pixelSize = diameter;
      cluster.point.color = Cesium.Color.fromCssColorString(SITES_CLUSTER_FILL);
      cluster.point.outlineColor = Cesium.Color.fromCssColorString(SITES_CLUSTER_OUTLINE);
      cluster.point.outlineWidth = 2;
      cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      cluster.label.show = true;
      cluster.label.text = String(count);
      cluster.label.font = '600 13px "IBM Plex Mono", monospace';
      cluster.label.fillColor = Cesium.Color.fromCssColorString(SITES_CLUSTER_TEXT);
      cluster.label.showBackground = false;
      cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
      cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
      cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      cluster.label.pixelOffset = new Cesium.Cartesian2(0, 0);
    }
  });
}

/**
 * Read camera height above ellipsoid (m). Falls back to high (country) LOD.
 * @returns {number}
 */
function cameraHeightM() {
  try {
    const h = _viewer?.camera?.positionCartographic?.height;
    if (Number.isFinite(h) && h > 0) return h;
  } catch { /* ignore */ }
  return 500_000;
}

/**
 * Apply zoom-dependent cluster density. Country/province → large pixelRange +
 * high minimumClusterSize so DEMO does not draw thousands of pins at SA overview.
 * @param {{force?:boolean}} [opts]
 */
function applySitesClusterLod({ force = false } = {}) {
  const ds = _dataSource;
  if (!ds?.clustering) return;
  const { pixelRange, minimumClusterSize } = clusterParamsForHeight(cameraHeightM(), {
    fast: isPerformanceFastPreset(),
  });
  const key = `${pixelRange}:${minimumClusterSize}`;
  if (!force && key === _lastClusterLodKey) return;
  _lastClusterLodKey = key;
  const clustering = ds.clustering;
  const wasEnabled = clustering.enabled;
  clustering.minimumClusterSize = minimumClusterSize;
  // Touch pixelRange (even 0→value) to force Cesium to rebuild aggregates.
  clustering.pixelRange = 0;
  clustering.pixelRange = pixelRange;
  if (!wasEnabled) clustering.enabled = true;
  governorRequestRender('sites:cluster-lod');
}

function scheduleSitesClusterLod() {
  if (_lodTimer) clearTimeout(_lodTimer);
  _lodTimer = setTimeout(() => {
    _lodTimer = null;
    if (_enabled && _dataSource) applySitesClusterLod();
  }, 120);
}

function installClusterLodWatcher() {
  if (!_viewer || _removeCameraLod) return;
  const cam = _viewer.camera;
  const onMove = () => scheduleSitesClusterLod();
  const removeChanged = cam.changed.addEventListener(onMove);
  const removeMoveEnd = cam.moveEnd.addEventListener(() => applySitesClusterLod());
  _removeCameraLod = () => {
    try { removeChanged(); } catch { /* ignore */ }
    try { removeMoveEnd(); } catch { /* ignore */ }
    if (_lodTimer) {
      clearTimeout(_lodTimer);
      _lodTimer = null;
    }
    _removeCameraLod = null;
  };
  applySitesClusterLod({ force: true });
}

function removeClusterLodWatcher() {
  _removeCameraLod?.();
  _removeCameraLod = null;
}

function ensureDataSource() {
  if (_dataSource) return _dataSource;
  const ds = new Cesium.CustomDataSource('Sites');
  ds.clustering.enabled = true;
  const { pixelRange, minimumClusterSize } = clusterParamsForHeight(cameraHeightM());
  ds.clustering.pixelRange = pixelRange;
  ds.clustering.minimumClusterSize = minimumClusterSize;
  ds.show = _enabled;
  _viewer.dataSources.add(ds);
  _dataSource = ds;
  installSitesClusterStyling(ds);
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
  styleEntity(entity);

  const pos = featurePosition(entity);
  let latitude = null;
  let longitude = null;
  if (pos) {
    const carto = Cesium.Cartographic.fromCartesian(pos);
    latitude = Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6));
    longitude = Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6));
  }

  _featureByUid.set(uid, { entity, props, name, latitude, longitude });
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
 * stream during idle time. Clustering is paused during bulk create so Cesium
 * does not rebuild aggregates after every batch.
 * @param {object[]} features
 * @param {object} options
 */
async function paintFeatures(features, {
  signal,
  generation,
  firstPaint = SITES_FIRST_PAINT_CAP,
  batchSize = sitesPaintBatchSize({ streaming: false }),
  streaming = false,
} = {}) {
  if (!_viewer || _destroyed) return;
  const list = dedupeFeaturesByUid(Array.isArray(features) ? features : []);
  _totalPlanned = list.length;
  ensureDataSource();
  _dataSource.show = _enabled;

  const effectiveBatch = batchSize || sitesPaintBatchSize({ streaming });
  const yieldMs = sitesPaintYieldMs({ streaming });
  const immediate = list.slice(0, firstPaint);
  const remainder = list.slice(firstPaint);

  const clustering = _dataSource.clustering;
  const restoreClustering = clustering?.enabled !== false;
  if (clustering) clustering.enabled = false;

  try {
    setBusy('painting', null, `Painting ${Math.min(immediate.length, list.length)}/${list.length}…`);
    await mapInBatches(immediate, {
      batchSize: effectiveBatch,
      signal,
      idleTimeoutMs: yieldMs,
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
    await yieldToMain({ signal, timeoutMs: yieldMs });

    if (!remainder.length) {
      setBusy(_count ? 'nominal' : 'empty');
      return;
    }

    const streamBatch = sitesPaintBatchSize({ streaming: true });
    const streamYield = sitesPaintYieldMs({ streaming: true });
    await mapInBatches(remainder, {
      batchSize: streamBatch,
      signal,
      idleTimeoutMs: streamYield,
      onProgress: ({ done }) => {
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
  } finally {
    if (clustering && restoreClustering) {
      clustering.enabled = true;
      applySitesClusterLod({ force: true });
    }
  }
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
    setBusy('empty', null, 'Click DEMO, IMPORT, or PIN');
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

function listSiteSummaries() {
  const out = [];
  for (const [uid, record] of _featureByUid) {
    out.push({
      uid,
      name: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
    });
  }
  return out;
}

function selectSiteEntity(entity) {
  if (!entity?.__siteUid) return;
  const uid = entity.__siteUid;
  const record = _featureByUid.get(uid);
  const props = record?.props || unwrapProperties(
    entity.properties?.getValue?.(Cesium.JulianDate.now()) || {},
  );
  const name = record?.name || props._name || 'Site';
  let latitude = record?.latitude ?? null;
  let longitude = record?.longitude ?? null;
  const pos = featurePosition(entity);
  if ((!Number.isFinite(latitude) || !Number.isFinite(longitude)) && pos) {
    const carto = Cesium.Cartographic.fromCartesian(pos);
    latitude = Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6));
    longitude = Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6));
  }

  _viewer.selectedEntity = entity;
  selectEntityContext(entity);

  const layerEntry = _catalog.find((entry) => entry.id === (props._layerId || DEMO_LAYER_ID));
  openSiteCard({
    uid,
    name,
    properties: props,
    latitude,
    longitude,
    layerName: layerEntry?.name
      || (props._layerId === DROPPED_PINS_LAYER_ID ? DROPPED_PINS_LAYER_NAME : DEMO_LAYER_NAME),
    sites: listSiteSummaries(),
  });

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
      if (_placeMode) setPlaceMode(false);
      selectSiteEntity(entity);
      return;
    }
    if (_placeMode) {
      const point = pickLatLonFromClick(click.position);
      if (point) {
        void dropPinAt(point.latitude, point.longitude);
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

/**
 * Ground pick for drop-pin mode (globe / ellipsoid).
 * @param {import('cesium').Cartesian2} screenPosition
 * @returns {{latitude:number, longitude:number}|null}
 */
function pickLatLonFromClick(screenPosition) {
  if (!_viewer || !screenPosition) return null;
  const scene = _viewer.scene;
  let cartesian = null;
  try {
    const ray = _viewer.camera.getPickRay(screenPosition);
    if (ray && scene.globe) {
      cartesian = scene.globe.pick(ray, scene);
    }
  } catch { /* ignore */ }
  if (!cartesian) {
    try {
      cartesian = _viewer.camera.pickEllipsoid(screenPosition, scene.globe?.ellipsoid);
    } catch { /* ignore */ }
  }
  if (!cartesian) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)),
    longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6)),
  };
}

function ensurePlaceHint() {
  if (_placeHint || typeof document === 'undefined') return _placeHint;
  const el = document.createElement('div');
  el.id = 'sites-place-hint';
  el.className = 'sites-place-hint';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.textContent = 'Click map to drop a site · Esc cancels';
  document.body.appendChild(el);
  _placeHint = el;
  return el;
}

function setPlaceMode(on) {
  const next = Boolean(on);
  if (_placeMode === next) {
    notifyRowControls();
    return;
  }
  _placeMode = next;
  const hint = ensurePlaceHint();
  if (hint) {
    hint.hidden = !_placeMode;
  }
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('sites-place-mode', _placeMode);
  }
  if (_placeMode) {
    if (!_placeModeKeyHandler && typeof window !== 'undefined') {
      _placeModeKeyHandler = (event) => {
        if (event.key === 'Escape') setPlaceMode(false);
      };
      window.addEventListener('keydown', _placeModeKeyHandler);
    }
  } else if (_placeModeKeyHandler && typeof window !== 'undefined') {
    window.removeEventListener('keydown', _placeModeKeyHandler);
    _placeModeKeyHandler = null;
  }
  notifyRowControls();
  setBusy(
    _count ? 'nominal' : 'empty',
    null,
    _placeMode ? 'Click map to drop a site' : (_count ? '' : 'Click DEMO, IMPORT, or PIN'),
  );
}

function makeDroppedUid() {
  return `sites:dropped:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist + paint one hand-dropped Sites pin, then open the research brief.
 * @param {number} latitude
 * @param {number} longitude
 */
async function dropPinAt(latitude, longitude) {
  if (!_viewer || _destroyed || !_enabled) return;
  if (![latitude, longitude].every(Number.isFinite)) return;

  ensureDataSource();
  _dataSource.show = true;

  const uid = makeDroppedUid();
  const name = 'Dropped pin';
  const feature = {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
    properties: {
      _uid: uid,
      _name: name,
      _layerId: DROPPED_PINS_LAYER_ID,
      Name: name,
      source: 'dropped',
    },
  };

  ensureSiteMetadata(uid, name);

  // Append into the dedicated Dropped pins GeoJSON layer (IndexedDB).
  try {
    const existing = await loadLayerGeoJSON(DROPPED_PINS_LAYER_ID).catch(() => null);
    const features = Array.isArray(existing?.features) ? [...existing.features] : [];
    features.push(feature);
    const geojson = { type: 'FeatureCollection', features };
    await saveLayerGeoJSON(DROPPED_PINS_LAYER_ID, geojson);
    _catalog = loadLayerCatalog().filter((entry) => entry.id !== DROPPED_PINS_LAYER_ID);
    _catalog.push(createLayerCatalogEntry({
      id: DROPPED_PINS_LAYER_ID,
      name: DROPPED_PINS_LAYER_NAME,
      filename: 'dropped-pins.geojson',
      type: 'geojson',
      featureCount: features.length,
      geometryTypes: ['Point'],
    }));
    saveLayerCatalog(_catalog);
  } catch (err) {
    console.warn('[Sites] failed to persist dropped pin:', err);
  }

  const entity = addFeatureEntity(feature, _featureByUid.size);
  _count = _featureByUid.size;
  _lastUpdate = Date.now();
  setPlaceMode(false);
  setBusy(_count ? 'nominal' : 'empty');
  notifyRowControls();
  governorRequestRender('sites:drop-pin');

  if (entity) {
    selectSiteEntity(entity);
  } else {
    openSiteCard({
      uid,
      name,
      properties: feature.properties,
      latitude,
      longitude,
      layerName: DROPPED_PINS_LAYER_NAME,
      sites: listSiteSummaries(),
    });
  }
}

function renameSiteFeature(uid, nextName) {
  const record = _featureByUid.get(uid);
  if (record) {
    record.name = nextName;
    if (record.props) {
      record.props._name = nextName;
      record.props.Name = nextName;
    }
  }
  const entity = _dataSource?.entities?.getById?.(uid);
  if (entity?.properties) {
    try {
      entity.properties._name = nextName;
      entity.properties.Name = nextName;
    } catch { /* ignore */ }
  }
  upsertSiteMetadata(uid, { site_name: nextName });
}

/**
 * Remove one Sites pin from the globe + owning layer persistence.
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function deleteSiteFeature(uid) {
  if (!uid || _destroyed) return false;
  const record = _featureByUid.get(uid);
  const props = record?.props
    || (record?.entity?.properties?.getValue?.(Cesium.JulianDate.now()) || {});
  const layerId = props?._layerId || DEMO_LAYER_ID;

  // Globe / in-memory first so the UI feels instant.
  const entity = record?.entity || _dataSource?.entities?.getById?.(uid);
  if (_dataSource && entity) {
    try { _dataSource.entities.remove(entity); } catch { /* ignore */ }
  }
  _featureByUid.delete(uid);
  _count = _featureByUid.size;
  _lastUpdate = Date.now();

  try {
    const store = getContextStore();
    const contextId = `${SITES_LAYER_ID}:${uid}`;
    store.entities.delete(contextId);
    if (store.selectedEntityId === contextId) {
      store.selectedEntityId = null;
      store.selectedAt = null;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
          detail: { layerId: SITES_LAYER_ID, reason: 'deliberate' },
        }));
      }
    }
  } catch { /* ignore */ }

  if (_viewer?.selectedEntity?.__siteUid === uid) {
    _viewer.selectedEntity = undefined;
  }
  clearSelectedEntityContextForLayer(SITES_LAYER_ID);
  deleteSiteMetadata(uid);
  closeSiteCard();

  // Persist: drop the feature from its layer GeoJSON (dropped / import / demo).
  try {
    const existing = await loadLayerGeoJSON(layerId).catch(() => null);
    const features = Array.isArray(existing?.features) ? existing.features : null;
    if (features) {
      const nextFeatures = features.filter((f) => f?.properties?._uid !== uid);
      if (nextFeatures.length !== features.length) {
        if (nextFeatures.length === 0) {
          await deleteLayerGeoJSON(layerId).catch(() => {});
          _catalog = loadLayerCatalog().filter((entry) => entry.id !== layerId);
          saveLayerCatalog(_catalog);
        } else {
          await saveLayerGeoJSON(layerId, {
            type: 'FeatureCollection',
            features: nextFeatures,
          });
          _catalog = loadLayerCatalog();
          const entry = _catalog.find((row) => row.id === layerId);
          if (entry) {
            entry.feature_count = nextFeatures.length;
            saveLayerCatalog(_catalog);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Sites] failed to persist pin delete:', err);
  }

  setBusy(_count ? 'nominal' : 'empty', null, _count ? '' : 'Click DEMO, IMPORT, or PIN');
  notifyRowControls();
  if (_dataSource?.clustering) applySitesClusterLod({ force: true });
  governorRequestRender('sites:delete-pin');
  return true;
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
    // Near-camera / Cape Town first; smaller idle batches so the globe stays responsive.
    let extra = dedupeFeaturesByUid(full.features).filter((f) => {
      const uid = f.properties?._uid;
      return uid && !hasEntityId(uid);
    });
    try {
      const carto = _viewer?.camera?.positionCartographic;
      if (carto) {
        extra = prioritizeFeaturesNear(
          extra,
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
        );
      } else {
        extra = prioritizeFeaturesNear(extra, 18.42, -33.92);
      }
    } catch {
      extra = prioritizeFeaturesNear(extra, 18.42, -33.92);
    }
    if (extra.length) {
      _totalPlanned = _count + extra.length;
      setBusy('painting', null, `Painting ${_count}/${_totalPlanned}…`);
      const clustering = _dataSource?.clustering;
      const restoreClustering = clustering?.enabled !== false;
      if (clustering) clustering.enabled = false;
      try {
        await mapInBatches(extra, {
          batchSize: sitesPaintBatchSize({ streaming: true }),
          signal,
          idleTimeoutMs: sitesPaintYieldMs({ streaming: true }),
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
      } finally {
        if (clustering && restoreClustering) {
          clustering.enabled = true;
          applySitesClusterLod({ force: true });
        }
      }
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
  setPlaceMode(false);
  setBusy('empty', null, 'Click DEMO, IMPORT, or PIN');
}

async function handlePendingAction() {
  const action = _pendingAction;
  _pendingAction = null;
  if (!action) return;
  if (action === 'import') {
    setPlaceMode(false);
    ensureFileInput()?.click();
    return;
  }
  if (action === 'demo') {
    setPlaceMode(false);
    await runDemoLoad();
    return;
  }
  if (action === 'clear') {
    setPlaceMode(false);
    await clearImportedLayers();
    return;
  }
  if (action === 'cancel') {
    if (_placeMode) {
      setPlaceMode(false);
      return;
    }
    cancelLoad();
    setBusy(_count ? 'nominal' : 'empty', null, 'Cancelled');
    return;
  }
  if (action === 'fly') {
    setPlaceMode(false);
    flyToCurrentFeatures();
    return;
  }
  if (action === 'pin-toggle') {
    setPlaceMode(!_placeMode);
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
    setSiteCardNameChangeListener(renameSiteFeature);
    setSiteCardDeleteListener((uid) => { void deleteSiteFeature(uid); });
  },

  async update() {},

  getStats() {
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
      placeMode: _placeMode,
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
        id: 'sites-pin',
        label: 'PIN',
        title: _placeMode
          ? 'Place mode on — click the globe to drop a site (Esc cancels)'
          : 'Drop a Sites pin on the globe',
        active: _placeMode,
        disabled: busy,
        state: _placeMode ? 'active' : 'idle',
        params: { sitesAction: 'pin-toggle' },
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
    if (busy || _placeMode) {
      chips.splice(1, 0, {
        id: 'sites-cancel',
        label: 'CANCEL',
        title: _placeMode ? 'Exit drop-pin mode' : 'Cancel the current import / demo load',
        active: false,
        disabled: false,
        params: { sitesAction: 'cancel' },
      });
    }
    return {
      chips,
      legend: [
        { color: SITES_COLOR, label: 'Sites', count: '' },
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
    ensurePlaceHint();
    installClusterLodWatcher();
    if (!_unsubFastPreset) {
      _unsubFastPreset = onPerformanceFastChange(() => {
        if (_enabled && _dataSource) applySitesClusterLod({ force: true });
      });
    }
    if (_dataSource) {
      _dataSource.show = true;
      applySitesClusterLod({ force: true });
      setBusy(_count ? 'nominal' : 'empty', null, _count ? '' : 'Click DEMO, IMPORT, or PIN');
    } else {
      await loadCachedOrPromptEmpty();
    }
    governorRequestRender('sites:enable');
  },

  disable() {
    _enabled = false;
    setPlaceMode(false);
    cancelLoad();
    removeClusterLodWatcher();
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
    _unsubFastPreset?.();
    _unsubFastPreset = null;
    setSiteCardNameChangeListener(null);
    setSiteCardDeleteListener(null);
    _dropCleanup?.();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_fileInput) {
      _fileInput.remove();
      _fileInput = null;
    }
    if (_placeHint) {
      _placeHint.remove();
      _placeHint = null;
    }
    clearDataSource();
    if (_dataSource && (viewer || _viewer)) {
      try { (viewer || _viewer).dataSources.remove(_dataSource, true); } catch { /* ignore */ }
    }
    _viewer = null;
  },
};

export default sitesLayer;

/** Test / QA seam. */
export function __sitesTestHooks() {
  return {
    get placeMode() { return _placeMode; },
    setPlaceMode,
    pickLatLonFromClick,
    makeDroppedUid,
  };
}

/** Test helpers */
export function _resetSitesLayerForTest() {
  cancelLoad();
  removeClusterLodWatcher();
  _unsubFastPreset?.();
  _unsubFastPreset = null;
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
  _lastClusterLodKey = '';
}
