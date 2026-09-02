/**
 * Area News data layer — property-facing headlines for the focused camera area.
 *
 * Reuses `/api/regional-brief?mode=area-news` (Nominatim + Google News RSS /
 * GDELT). Off by default. When enabled, opens a Sites-style widget and refreshes
 * on camera / selected-site focus changes (distance + age gated).
 */
import * as Cesium from 'cesium';
import {
  fetchRegionalBrief,
  regionalDistanceM,
} from './regionalBrief.js';
import {
  closeAreaNewsCard,
  ensureAreaNewsCardVisible,
  isAreaNewsCardOpen,
  renderAreaNewsCard,
} from '../ui/areaNewsCard.js';
import { getOpenSiteFocus } from '../sites/siteCard.js';

export const AREA_NEWS_LAYER_ID = 'area-news';

/** Min age before a same-cell refetch (ms). */
const REFRESH_MIN_AGE_MS = 90_000;
/** Move farther than this to force a refresh even if young. */
const REFRESH_DISTANCE_M = 12_000;
/** Manager poll interval — actual network is gated above. */
const UPDATE_INTERVAL_MS = 8_000;

let _viewer = null;
let _enabled = false;
let _count = 0;
let _lastUpdate = null;
let _lastError = null;
let _status = 'idle';
let _placeLabel = null;
let _newsSource = null;
/** @type {AbortController|null} */
let _abort = null;
let _requestToken = 0;
/** @type {{latitude:number, longitude:number}|null} */
let _anchor = null;
let _fetchedAt = 0;
/** @type {(event:Event)=>void}|null */
let _siteCardListener = null;

function toDeg(rad) {
  return Cesium.Math.toDegrees(rad);
}

/**
 * Camera look-at ground point, falling back to nadir.
 * @param {import('cesium').Viewer} viewer
 * @returns {{latitude:number, longitude:number}|null}
 */
export function getCameraFocusPoint(viewer) {
  if (!viewer?.camera || !viewer?.scene) return null;
  const carto = viewer.camera.positionCartographic;
  if (!carto) return null;
  const canvas = viewer.scene.canvas;
  if (canvas?.clientWidth > 0 && canvas?.clientHeight > 0) {
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const hit = viewer.camera.pickEllipsoid(center, viewer.scene.globe?.ellipsoid);
    if (hit) {
      const hitCarto = Cesium.Cartographic.fromCartesian(hit);
      if (hitCarto) {
        return {
          latitude: toDeg(hitCarto.latitude),
          longitude: toDeg(hitCarto.longitude),
        };
      }
    }
  }
  return {
    latitude: toDeg(carto.latitude),
    longitude: toDeg(carto.longitude),
  };
}

/**
 * Prefer an open Sites pin when present; otherwise camera focus.
 * @param {import('cesium').Viewer} viewer
 * @returns {{latitude:number, longitude:number, siteName?:string|null}|null}
 */
export function resolveAreaNewsFocus(viewer) {
  const site = getOpenSiteFocus();
  if (site && Number.isFinite(site.latitude) && Number.isFinite(site.longitude)) {
    return {
      latitude: site.latitude,
      longitude: site.longitude,
      siteName: site.name || null,
    };
  }
  const cam = getCameraFocusPoint(viewer);
  if (!cam) return null;
  return { ...cam, siteName: null };
}

function cancelFetch() {
  if (_abort) {
    _abort.abort();
    _abort = null;
  }
  _requestToken += 1;
}

async function refreshForFocus(focus, { force = false } = {}) {
  if (!_enabled || !focus) return;
  const ageMs = Date.now() - _fetchedAt;
  const distanceM = regionalDistanceM(_anchor, focus);
  if (!force && _abort) return;
  if (!force && ageMs < REFRESH_MIN_AGE_MS && distanceM < REFRESH_DISTANCE_M) return;

  cancelFetch();
  const controller = new AbortController();
  const token = _requestToken;
  _abort = controller;
  _anchor = { latitude: focus.latitude, longitude: focus.longitude };
  _fetchedAt = Date.now();
  _status = 'loading';
  _lastError = null;

  if (force || isAreaNewsCardOpen()) {
    ensureAreaNewsCardVisible({ force });
    renderAreaNewsCard({
      state: 'loading',
      place: _placeLabel ? { label: _placeLabel } : null,
      focusLabel: focus.siteName || null,
    });
  }

  try {
    const payload = await fetchRegionalBrief(focus.latitude, focus.longitude, {
      signal: controller.signal,
      mode: 'area-news',
    });
    if (!_enabled || token !== _requestToken) return;

    const articles = Array.isArray(payload?.articles) ? payload.articles : [];
    _placeLabel = payload?.place?.label
      || focus.siteName
      || payload?.place?.country
      || 'Focused area';
    _newsSource = payload?.newsSource || null;
    _count = articles.length;
    _lastUpdate = Date.now();
    _lastError = null;

    // Quiet background refresh while dismissed — stats update, panel stays closed.
    if (!force && !isAreaNewsCardOpen()) {
      _status = articles.length ? 'ready' : (payload?.newsStatus === 'unavailable' ? 'unavailable' : 'empty');
      return;
    }
    ensureAreaNewsCardVisible({ force: true });

    if (payload?.newsStatus === 'unavailable' && articles.length === 0) {
      _status = 'unavailable';
      renderAreaNewsCard({
        state: 'unavailable',
        place: payload?.place || { label: _placeLabel },
        articles: [],
        newsSource: _newsSource,
        message: 'Area news is temporarily unavailable.',
      });
      return;
    }

    if (articles.length === 0) {
      _status = 'empty';
      renderAreaNewsCard({
        state: 'empty',
        place: payload?.place || { label: _placeLabel },
        articles: [],
        newsSource: _newsSource,
        message: 'No recent retail/business headlines for this area.',
      });
      return;
    }

    _status = 'ready';
    renderAreaNewsCard({
      state: 'ready',
      place: payload?.place || { label: _placeLabel },
      articles,
      newsSource: _newsSource,
      focusLabel: focus.siteName,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || !_enabled || token !== _requestToken) return;
    _status = 'error';
    _lastError = err?.message || 'Area news unavailable';
    _count = 0;
    renderAreaNewsCard({
      state: 'error',
      place: _placeLabel ? { label: _placeLabel } : null,
      focusLabel: focus.siteName,
      message: 'Area news is temporarily unavailable.',
    });
  } finally {
    if (_abort === controller) _abort = null;
  }
}

const areaNewsLayer = {
  id: AREA_NEWS_LAYER_ID,
  name: 'Area News',
  icon: '◈',
  source: 'Regional brief',
  updateInterval: UPDATE_INTERVAL_MS,

  init(viewer) {
    _viewer = viewer;
    _enabled = false;
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _status = 'idle';
    _placeLabel = null;
    _newsSource = null;
    _anchor = null;
    _fetchedAt = 0;
    console.log('[Data:AreaNews] Initialized');
  },

  enable(viewer) {
    _viewer = viewer || _viewer;
    _enabled = true;
    _status = 'loading';
    if (!_siteCardListener && typeof window !== 'undefined') {
      _siteCardListener = () => {
        if (!_enabled || !_viewer) return;
        const focus = resolveAreaNewsFocus(_viewer);
        void refreshForFocus(focus, { force: true });
      };
      window.addEventListener('volee:site-card', _siteCardListener);
    }
    const focus = resolveAreaNewsFocus(_viewer);
    void refreshForFocus(focus, { force: true });
  },

  disable() {
    _enabled = false;
    cancelFetch();
    closeAreaNewsCard();
    if (_siteCardListener && typeof window !== 'undefined') {
      window.removeEventListener('volee:site-card', _siteCardListener);
      _siteCardListener = null;
    }
    _status = 'idle';
    _count = 0;
    _lastError = null;
    _placeLabel = null;
    _newsSource = null;
    _anchor = null;
    _fetchedAt = 0;
  },

  async update(viewer) {
    if (!_enabled) return false;
    _viewer = viewer || _viewer;
    const focus = resolveAreaNewsFocus(_viewer);
    await refreshForFocus(focus, { force: false });
    return true;
  },

  destroy() {
    this.disable();
    _viewer = null;
  },

  getStats() {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _lastError,
      status: _status,
      place: _placeLabel,
      newsSource: _newsSource,
    };
  },
};

export default areaNewsLayer;
