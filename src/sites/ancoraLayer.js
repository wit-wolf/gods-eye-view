/**
 * Ancora centres layer — static GeoJSON from public/sites/ancora-centres.geojson.
 * Distinct from Sites KMZ pins. EXAMPLE features are tagged example:true.
 * Occupancy / GLA / mandate shown only when present — never invented.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  selectEntityContext,
} from '../data/contextStore.js';
import { openSiteCard, closeSiteCard } from './siteCard.js';

export const ANCORA_LAYER_ID = 'ancora';
export const ANCORA_GEOJSON_URL = '/sites/ancora-centres.geojson';
/** Amber / copper — distinct from Sites teal (#3dd6c6). */
export const ANCORA_PIN_COLOR = '#e8a54b';

let _viewer = null;
let _enabled = false;
let _destroyed = false;
let _dataSource = null;
let _clickHandler = null;
let _count = 0;
let _lastUpdate = null;
let _error = null;
let _status = 'idle';
let _loading = false;
/** @type {Map<string, {entity:object, props:object, name:string, latitude:number|null, longitude:number|null}>} */
let _featureByUid = new Map();

function setStatus(status, error = null) {
  _status = status;
  _error = error;
  _loading = status === 'loading';
}

function unwrapProps(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // Cesium PropertyBag sometimes wraps values.
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && 'getValue' in value) {
      try { out[key] = value.getValue(Cesium.JulianDate.now()); } catch { out[key] = value; }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function featureUid(feature, index) {
  const id = feature?.id ?? feature?.properties?.id ?? feature?.properties?._uid;
  if (id != null && String(id).trim()) return `ancora:${String(id).trim()}`;
  const name = feature?.properties?.name || feature?.properties?.Name || 'centre';
  return `ancora:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`;
}

function featureName(props) {
  return String(props?.name || props?.Name || props?._name || 'Ancora centre').slice(0, 160);
}

function clearEntities() {
  clearSelectedEntityContextForLayer(ANCORA_LAYER_ID);
  _featureByUid = new Map();
  _count = 0;
  if (_dataSource) {
    try { _dataSource.entities.removeAll(); } catch { /* ignore */ }
  }
}

function ensureDataSource() {
  if (_dataSource) return _dataSource;
  const ds = new Cesium.CustomDataSource('Ancora');
  ds.show = _enabled;
  _viewer.dataSources.add(ds);
  _dataSource = ds;
  return ds;
}

function addCentreEntity(feature, index) {
  const geom = feature?.geometry;
  if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) return null;
  const [lon, lat] = geom.coordinates;
  if (![lon, lat].every(Number.isFinite)) return null;

  const props = { ...(feature.properties || {}), _layerId: ANCORA_LAYER_ID };
  const uid = featureUid(feature, index);
  if (_featureByUid.has(uid)) return _featureByUid.get(uid).entity;

  const name = featureName(props);
  const color = Cesium.Color.fromCssColorString(ANCORA_PIN_COLOR);
  const entity = _dataSource.entities.add({
    id: uid,
    name,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 11,
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
      outlineWidth: 1,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    properties: props,
  });
  entity.__ancoraLayerId = ANCORA_LAYER_ID;
  entity.__ancoraUid = uid;

  const latitude = Number(lat.toFixed(6));
  const longitude = Number(lon.toFixed(6));
  _featureByUid.set(uid, { entity, props, name, latitude, longitude });
  registerEntityContext(entity, {
    id: `${ANCORA_LAYER_ID}:${uid}`,
    layerId: ANCORA_LAYER_ID,
    layerName: 'Ancora',
    source: 'Ancora centres',
    dataSource: _dataSource,
    label: name,
    properties: props,
    latitude,
    longitude,
  });
  return entity;
}

async function loadCentres() {
  if (!_viewer || _destroyed) return;
  setStatus('loading');
  clearEntities();
  ensureDataSource();
  _dataSource.show = _enabled;

  let res;
  try {
    res = await fetch(ANCORA_GEOJSON_URL, { cache: 'no-cache' });
  } catch (err) {
    setStatus('unavailable', err?.message || 'fetch failed');
    return;
  }

  if (res.status === 404) {
    setStatus('empty', null);
    _error = null;
    _status = 'empty';
    return;
  }
  if (!res.ok) {
    setStatus('unavailable', `HTTP ${res.status}`);
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    setStatus('unavailable', 'Invalid GeoJSON');
    return;
  }

  const features = Array.isArray(data?.features) ? data.features : [];
  if (!features.length) {
    setStatus('empty');
    return;
  }

  for (let i = 0; i < features.length; i++) {
    addCentreEntity(features[i], i);
  }
  _count = _featureByUid.size;
  _lastUpdate = Date.now();
  setStatus(_count ? 'nominal' : 'empty');
  governorRequestRender('ancora:load');
}

function selectCentre(entity) {
  if (!entity?.__ancoraUid) return;
  const uid = entity.__ancoraUid;
  const record = _featureByUid.get(uid);
  const props = record?.props || unwrapProps(entity.properties?.getValue?.(Cesium.JulianDate.now()) || {});
  _viewer.selectedEntity = entity;
  selectEntityContext(entity);
  openSiteCard({
    uid,
    name: record?.name || featureName(props),
    properties: props,
    latitude: record?.latitude ?? null,
    longitude: record?.longitude ?? null,
    layerName: 'Ancora centres',
    sites: [],
    mode: 'ancora',
    showDelete: false,
    showNearbyImported: false,
    showAccess: true,
    showCompetitors: true,
    allowRename: false,
  });
}

function installClickHandler() {
  if (_clickHandler || !_viewer) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!_enabled) return;
    const picked = _viewer.scene.pick(click.position);
    const entity = picked?.id;
    if (entity && entity.__ancoraLayerId === ANCORA_LAYER_ID) {
      selectCentre(entity);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function removeClickHandler() {
  if (_clickHandler) {
    try { _clickHandler.destroy(); } catch { /* ignore */ }
    _clickHandler = null;
  }
}

const ancoraLayer = {
  id: ANCORA_LAYER_ID,
  name: 'Ancora',
  icon: '◈',
  source: 'Ancora centres (GeoJSON)',
  updateInterval: 0,
  statsRefreshInterval: 2000,

  async init(viewer) {
    _viewer = viewer;
    _destroyed = false;
  },

  async update() {},

  getStats() {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _error,
      loading: _loading,
      status: _status,
      source: _status === 'empty'
        ? 'Ancora · no centres in GeoJSON'
        : _status === 'unavailable'
          ? `Ancora · ${_error || 'unavailable'}`
          : 'Ancora centres · local GeoJSON',
    };
  },

  async enable(viewer) {
    if (_destroyed) return;
    _viewer = viewer || _viewer;
    _enabled = true;
    installClickHandler();
    ensureDataSource();
    _dataSource.show = true;
    await loadCentres();
    governorRequestRender('ancora:enable');
  },

  disable() {
    _enabled = false;
    removeClickHandler();
    if (_dataSource) _dataSource.show = false;
    clearSelectedEntityContextForLayer(ANCORA_LAYER_ID);
    if (_viewer?.selectedEntity?.__ancoraLayerId === ANCORA_LAYER_ID) {
      _viewer.selectedEntity = undefined;
      closeSiteCard();
    }
    setStatus('idle');
  },

  destroy(viewer) {
    if (_destroyed) return;
    _destroyed = true;
    this.disable();
    clearEntities();
    if (_dataSource && (viewer || _viewer)) {
      try { (viewer || _viewer).dataSources.remove(_dataSource, true); } catch { /* ignore */ }
    }
    _dataSource = null;
    _viewer = null;
  },
};

export default ancoraLayer;
