/**
 * Property Genius Sites layer — KMZ/KML import on the Cesium photoreal globe.
 *
 * Renders imported (and bundled demo) features as terrain-clamped points /
 * polygons. Click opens a GEV-style site card (status + scores + KML attrs).
 * Metadata persists in localStorage; GeoJSON in IndexedDB. No Azure SQL.
 *
 * Ambient stems from localGeojson.js are intentionally NOT used here: the
 * November demo alone is ~10k features, so we keep entity cost low.
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
  importAndProcessFile,
  parseGzippedGeoJSON,
  parseKML,
  processGeoJSON,
} from './importKml.js';
import { normalizeSiteStatus } from './scoring.js';
import { closeSiteCard, openSiteCard } from './siteCard.js';
import {
  DEMO_GEOJSON_GZ_URL,
  DEMO_KMZ_URL,
  DEMO_LAYER_ID,
  DEMO_LAYER_NAME,
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

export const SITES_LAYER_ID = 'sites';

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
let _lastUpdate = null;
let _error = null;
let _loading = false;
let _status = 'idle';
let _rowControlsListener = null;
let _pendingAction = null; // 'import' | 'demo' | 'clear' | 'fly'
/** @type {Map<string, object>} */
let _featureByUid = new Map();
/** @type {object[]} */
let _catalog = [];

function notifyRowControls() {
  try { _rowControlsListener?.(); } catch { /* panel refresh is best-effort */ }
}

function setBusy(status, error = null) {
  _status = status;
  _loading = status === 'loading' || status === 'converting';
  _error = error;
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

async function loadDemoGeoJSON() {
  // Prefer the pre-gzipped Point/Polygon subset for fast first paint.
  try {
    const response = await fetch(DEMO_GEOJSON_GZ_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const raw = await parseGzippedGeoJSON(buffer);
    return processGeoJSON(raw, DEMO_LAYER_ID);
  } catch (gzError) {
    console.warn('[Sites] gzipped demo unavailable, falling back to KMZ:', gzError);
    const response = await fetch(DEMO_KMZ_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const kml = await extractKMLFromKMZ(buffer);
    const raw = parseKML(kml);
    return processGeoJSON(raw, DEMO_LAYER_ID);
  }
}

async function collectVisibleFeatureCollections() {
  _catalog = loadLayerCatalog();
  if (_catalog.length === 0) {
    await ensureDemoCatalogEntry();
  }

  const collections = [];
  for (const entry of _catalog) {
    if (entry.visible === false) continue;
    let geojson = await loadLayerGeoJSON(entry.id).catch(() => null);
    if (!geojson && entry.id === DEMO_LAYER_ID) {
      geojson = await loadDemoGeoJSON();
      try { await saveLayerGeoJSON(entry.id, geojson); } catch { /* cache optional */ }
      entry.feature_count = geojson.features.length;
      entry.geometry_types = getGeometryTypes(geojson);
      saveLayerCatalog(_catalog);
    }
    if (geojson?.features?.length) collections.push(geojson);
  }
  return collections;
}

function mergeCollections(collections) {
  const features = [];
  for (const collection of collections) {
    for (const feature of collection.features || []) features.push(feature);
  }
  return { type: 'FeatureCollection', features };
}

function styleEntity(entity, uid) {
  const color = Cesium.Color.fromCssColorString(accentForUid(uid));
  if (entity.billboard) {
    entity.billboard = undefined;
  }
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
  // Prefer a compact point pick target for all geometries that have a position.
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

function propertyObject(entity) {
  const source = entity?.properties;
  const raw = typeof source?.getValue === 'function'
    ? source.getValue(Cesium.JulianDate.now())
    : source || {};
  return unwrapProperties(raw) || {};
}

async function rebuildDataSource() {
  if (!_viewer || _destroyed) return;
  setBusy('loading');

  removeEntityContextsForLayer(SITES_LAYER_ID);
  _featureByUid = new Map();

  if (_dataSource) {
    try { _viewer.dataSources.remove(_dataSource, true); } catch { /* gone */ }
    _dataSource = null;
  }

  try {
    const collections = await collectVisibleFeatureCollections();
    const merged = mergeCollections(collections);
    _count = merged.features.length;

    if (_count === 0) {
      _lastUpdate = Date.now();
      setBusy('empty');
      return;
    }

    const loaded = await Cesium.GeoJsonDataSource.load(merged, {
      clampToGround: true,
      markerSize: 8,
      strokeWidth: 2,
    });
    loaded.name = 'Sites';
    loaded.clustering.enabled = _count > 400;
    loaded.clustering.pixelRange = 18;
    loaded.clustering.minimumClusterSize = 4;

    await _viewer.dataSources.add(loaded);
    _dataSource = loaded;
    _dataSource.show = _enabled;

    const entities = loaded.entities.values;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const props = propertyObject(entity);
      const uid = props._uid || `sites:orphan:${i}`;
      const name = props._name || props.name || props.Name || `Site ${i + 1}`;
      ensureSiteMetadata(uid, name);
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
        dataSource: loaded,
        label: name,
        properties: props,
        latitude,
        longitude,
      });
    }

    _lastUpdate = Date.now();
    setBusy('nominal');
    governorRequestRender('sites:rebuild');
  } catch (error) {
    console.error('[Sites] rebuild failed:', error);
    _count = 0;
    setBusy('unavailable', error?.message || 'dataset unavailable');
  }
}

function selectSiteEntity(entity) {
  if (!entity?.__siteUid) return;
  const uid = entity.__siteUid;
  const record = _featureByUid.get(uid);
  const props = record?.props || propertyObject(entity);
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
  setBusy('converting');
  try {
    const layerId = makeLayerId(file.name);
    const geojson = await importAndProcessFile(file, layerId);
    if (!geojson.features.length) throw new Error('No features found in file');

    await saveLayerGeoJSON(layerId, geojson);
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

    if (_enabled) await rebuildDataSource();
    else setBusy('idle');
    flyToCurrentFeatures(geojson);
  } catch (error) {
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

async function clearImportedLayers() {
  _catalog = loadLayerCatalog();
  for (const entry of _catalog) {
    if (entry.id === DEMO_LAYER_ID) continue;
    try { await deleteLayerGeoJSON(entry.id); } catch { /* ignore */ }
  }
  _catalog = _catalog.filter((entry) => entry.id === DEMO_LAYER_ID);
  if (!_catalog.length) await ensureDemoCatalogEntry();
  saveLayerCatalog(_catalog);
  if (_enabled) await rebuildDataSource();
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
    setBusy('loading');
    try {
      await deleteLayerGeoJSON(DEMO_LAYER_ID).catch(() => {});
      await ensureDemoCatalogEntry();
      const geojson = await loadDemoGeoJSON();
      await saveLayerGeoJSON(DEMO_LAYER_ID, geojson);
      _catalog = loadLayerCatalog();
      const demo = _catalog.find((entry) => entry.id === DEMO_LAYER_ID);
      if (demo) {
        demo.feature_count = geojson.features.length;
        demo.geometry_types = getGeometryTypes(geojson);
        demo.visible = true;
        saveLayerCatalog(_catalog);
      }
      if (_enabled) {
        await rebuildDataSource();
        flyToCurrentFeatures(geojson);
      }
    } catch (error) {
      setBusy('unavailable', error?.message || 'demo load failed');
    }
    return;
  }
  if (action === 'clear') {
    await clearImportedLayers();
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

  async update() {
    // Static layer — rebuild is driven by import / enable.
  },

  getStats() {
    const settings = loadSiteSettings();
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _error,
      loading: _loading,
      status: _status,
      source: 'Property Genius · local',
      scoringWeights: settings.scoring_weights,
    };
  },

  getRowControls() {
    const busy = _loading;
    return {
      chips: [
        {
          id: 'sites-import',
          label: 'IMPORT',
          title: 'Import KMZ / KML / GeoJSON',
          active: false,
          disabled: busy,
          params: { sitesAction: 'import' },
        },
        {
          id: 'sites-demo',
          label: 'DEMO',
          title: 'Load November Google Earth Pins demo',
          active: false,
          disabled: busy,
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
          title: 'Clear user imports (keeps demo catalog entry)',
          active: false,
          disabled: busy,
          params: { sitesAction: 'clear' },
        },
      ],
      legend: [
        { color: STATUS_COLORS.lead, label: 'Lead', count: null, blurb: 'Lead' },
        { color: STATUS_COLORS.screening, label: 'Screening', count: null },
        { color: STATUS_COLORS.shortlisted, label: 'Shortlisted', count: null },
        { color: STATUS_COLORS.rejected, label: 'Rejected', count: null },
      ].map((item) => ({ ...item, count: item.count ?? '' })),
    };
  },

  setRowControlsListener(listener) {
    _rowControlsListener = typeof listener === 'function' ? listener : null;
  },

  setParams(next = {}) {
    if (next.sitesAction) {
      _pendingAction = next.sitesAction;
      // Fire async without blocking the params latch.
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
      setBusy('nominal');
    } else {
      await rebuildDataSource();
      // First enable with the demo: frame Cape Town / SA pins.
      if (_count > 0) flyToCurrentFeatures();
    }
    governorRequestRender('sites:enable');
  },

  disable() {
    _enabled = false;
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
    if (_dataSource && (viewer || _viewer)) {
      try { (viewer || _viewer).dataSources.remove(_dataSource, true); } catch { /* ignore */ }
    }
    removeEntityContextsForLayer(SITES_LAYER_ID);
    _dataSource = null;
    _featureByUid = new Map();
    _count = 0;
    _viewer = null;
  },
};

export default sitesLayer;

/** Test helpers */
export function _resetSitesLayerForTest() {
  _viewer = null;
  _enabled = false;
  _destroyed = false;
  _dataSource = null;
  _clickHandler = null;
  _dropCleanup = null;
  _fileInput = null;
  _count = 0;
  _lastUpdate = null;
  _error = null;
  _loading = false;
  _status = 'idle';
  _rowControlsListener = null;
  _pendingAction = null;
  _featureByUid = new Map();
  _catalog = [];
}