/**
 * Load Access / traffic stats for a Sites research brief pin.
 * Reuses TomTom flow tiles; drive-time via free-tier reachable-range proxy.
 * Never invents live % or demographics — degrades honestly when keyless / over quota.
 */

import { fetchFlowForBounds } from '../data/flowTiles.js';
import {
  DRIVE_TIME_MINUTES,
  boundsAroundPin,
  filterSegmentsNearPin,
  flowCoverageNote,
  formatKm,
  reachableCacheKey,
  summarizeFlowSegments,
  summarizeReachableBoundary,
} from './accessStatsSummary.js';

/** Client cache for reachable-range summaries (aggressive — network is static-ish). */
const _reachCache = new Map();
const REACH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REACH_CACHE_MAX = 48;

/** @type {Promise<{hasKey:boolean}|null>|null} */
let _statusPromise = null;

function reachCacheGet(key) {
  const hit = _reachCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > REACH_CACHE_TTL_MS) {
    _reachCache.delete(key);
    return null;
  }
  return hit.value;
}

function reachCacheSet(key, value) {
  if (!_reachCache.has(key) && _reachCache.size >= REACH_CACHE_MAX) {
    const oldest = _reachCache.keys().next().value;
    _reachCache.delete(oldest);
  }
  _reachCache.set(key, { at: Date.now(), value });
}

/**
 * Session TomTom status (same honesty gate as the traffic layer).
 * @param {AbortSignal} [signal]
 * @returns {Promise<{hasKey:boolean, statusOk:boolean}>}
 */
export async function fetchTomTomStatus(signal) {
  if (!_statusPromise) {
    _statusPromise = fetch('/api/tomtom/status', { signal: undefined })
      .then(async (res) => {
        if (!res.ok) return { hasKey: false, statusOk: false };
        const data = await res.json().catch(() => ({}));
        return { hasKey: Boolean(data?.hasKey), statusOk: true };
      })
      .catch(() => ({ hasKey: false, statusOk: false }))
      .finally(() => {
        // Allow a later retry if this call was aborted before settle — keep
        // resolved promises so keyless sessions stay cheap.
      });
  }
  // If caller aborted while we await a shared promise, still honour abort.
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  const status = await _statusPromise;
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  return status;
}

/** Reset status memo (tests). */
export function resetTomTomStatusCache() {
  _statusPromise = null;
}

/** Reset reachable-range client cache (tests). */
export function resetReachableClientCache() {
  _reachCache.clear();
}

/**
 * @param {number} lat @param {number} lon @param {number} minutes
 * @param {AbortSignal} [signal]
 * @returns {Promise<{
 *   minutes:number,
 *   state:'ok'|'unavailable'|'budget'|'error',
 *   medianKm:number|null,
 *   maxKm:number|null,
 *   note?:string
 * }>}
 */
async function fetchReachableRange(lat, lon, minutes, signal) {
  const key = reachableCacheKey(lat, lon, minutes);
  const cached = reachCacheGet(key);
  if (cached) return { ...cached, fromCache: true };

  const qs = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    minutes: String(minutes),
  });
  let res;
  try {
    res = await fetch(`/api/tomtom/reachable-range?${qs}`, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      minutes,
      state: 'error',
      medianKm: null,
      maxKm: null,
      note: 'Routing request failed',
    };
  }

  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    const state = body?.error === 'no_key' ? 'unavailable' : 'error';
    return {
      minutes,
      state,
      medianKm: null,
      maxKm: null,
      note: state === 'unavailable' ? 'TomTom key not configured' : 'Routing unavailable',
    };
  }
  if (res.status === 429) {
    return {
      minutes,
      state: 'budget',
      medianKm: null,
      maxKm: null,
      note: 'Free-tier routing budget reached — try again later',
    };
  }
  if (!res.ok) {
    return {
      minutes,
      state: 'error',
      medianKm: null,
      maxKm: null,
      note: `Routing HTTP ${res.status}`,
    };
  }

  const data = await res.json().catch(() => ({}));
  const origin = { lat, lon };
  const boundary = Array.isArray(data?.boundary) ? data.boundary : [];
  const ring = summarizeReachableBoundary(origin, boundary);
  const value = {
    minutes,
    state: ring.medianKm != null ? 'ok' : 'error',
    medianKm: ring.medianKm,
    maxKm: ring.maxKm,
    note: ring.medianKm != null
      ? undefined
      : 'Reachable-range returned no boundary',
  };
  if (value.state === 'ok') reachCacheSet(key, value);
  return value;
}

/**
 * Load flow + drive-time access stats for a pin.
 *
 * @param {object} opts
 * @param {number} opts.latitude
 * @param {number} opts.longitude
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   flow: object,
 *   drive: object,
 * }>}
 */
export async function loadSiteAccessStats({ latitude, longitude, signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      flow: {
        mode: 'unavailable',
        summary: summarizeFlowSegments([]),
        coverageNote: 'Pin has no coordinates — cannot fetch access stats.',
        snapshotNote: null,
      },
      drive: {
        mode: 'unavailable',
        rings: [],
        note: 'Pin has no coordinates.',
      },
    };
  }

  const status = await fetchTomTomStatus(signal);
  const hasKey = status.hasKey && status.statusOk;

  /** @type {object} */
  let flow;
  if (!hasKey) {
    flow = {
      mode: status.statusOk ? 'simulated' : 'unavailable',
      summary: summarizeFlowSegments([]),
      coverageNote: status.statusOk
        ? 'No TomTom key — traffic layer uses a labeled simulation; live % are not invented here.'
        : 'TomTom status unreachable — live flow unavailable.',
      snapshotNote: null,
    };
  } else {
    try {
      const bounds = boundsAroundPin(latitude, longitude, 1.5);
      const segments = await fetchFlowForBounds(bounds, { signal, zoom: 12 });
      const near = filterSegmentsNearPin(segments, latitude, longitude, 2);
      const summary = summarizeFlowSegments(near);
      flow = {
        mode: 'live',
        summary,
        coverageNote: flowCoverageNote(summary),
        snapshotNote:
          'Current snapshot from TomTom flow tiles (cached ~2 min) — not peak-hour historic.',
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      flow = {
        mode: 'unavailable',
        summary: summarizeFlowSegments([]),
        coverageNote: 'Live flow fetch failed near this pin.',
        snapshotNote: null,
      };
    }
  }

  /** @type {object} */
  let drive;
  if (!hasKey) {
    drive = {
      mode: status.statusOk ? 'unavailable' : 'unavailable',
      rings: DRIVE_TIME_MINUTES.map((minutes) => ({
        minutes,
        state: 'unavailable',
        medianKm: null,
        maxKm: null,
      })),
      note: status.statusOk
        ? 'Drive-time rings need a TomTom key (free-tier Routing). Not simulated.'
        : 'TomTom status unreachable — drive-time unavailable.',
    };
  } else {
    const rings = [];
    let anyBudget = false;
    let anyOk = false;
    for (const minutes of DRIVE_TIME_MINUTES) {
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      // Sequential to stay gentle on free-tier QPS / non-tile budget.
      // eslint-disable-next-line no-await-in-loop
      const ring = await fetchReachableRange(latitude, longitude, minutes, signal);
      rings.push(ring);
      if (ring.state === 'ok') anyOk = true;
      else if (ring.state === 'budget') anyBudget = true;
    }
    drive = {
      mode: anyOk ? 'live' : (anyBudget ? 'budget' : 'unavailable'),
      rings,
      note: anyOk
        ? 'Approximate car drive-time reach (TomTom reachable-range). Distances only — no demographics inside the rings.'
        : anyBudget
          ? 'Free-tier routing budget reached. Drive-time rings unavailable until the daily quota resets.'
          : 'Drive-time rings unavailable.',
    };
  }

  return { flow, drive };
}

/**
 * Build HTML fragments for the Access section (escaped by caller via text).
 * Returns plain structured strings for the card renderer.
 *
 * @param {{flow:object, drive:object}} stats
 * @returns {{flowLines:string[], driveLines:string[], footnotes:string[]}}
 */
export function accessStatsDisplayModel(stats) {
  const flowLines = [];
  const driveLines = [];
  const footnotes = [];
  const flow = stats?.flow;
  const drive = stats?.drive;

  if (!flow) {
    flowLines.push('Flow status unknown.');
  } else if (flow.mode === 'live' && flow.summary?.total > 0) {
    const s = flow.summary;
    flowLines.push(
      `${s.pctFree}% free · ${s.pctSlow}% slow · ${s.pctJam}% jam`
      + ` (${s.total} segments near pin)`
    );
    flowLines.push(
      s.closures > 0
        ? `${s.closures} road closure${s.closures === 1 ? '' : 's'} flagged in this snapshot`
        : 'No road closures flagged in this snapshot'
    );
  } else if (flow.mode === 'live') {
    flowLines.push('Live flow tiles returned no usable segments near this pin.');
  } else if (flow.mode === 'simulated') {
    flowLines.push('Live flow % unavailable (keyless — traffic uses a labeled simulation).');
  } else {
    flowLines.push('Live flow unavailable.');
  }
  if (flow?.coverageNote) footnotes.push(flow.coverageNote);
  if (flow?.snapshotNote) footnotes.push(flow.snapshotNote);

  if (!drive) {
    driveLines.push('Drive-time unknown.');
  } else {
    for (const ring of drive.rings || []) {
      if (ring.state === 'ok' && Number.isFinite(ring.medianKm)) {
        driveLines.push(
          `${ring.minutes} min ≈ ${formatKm(ring.medianKm)} median reach`
          + (Number.isFinite(ring.maxKm) ? ` (max ${formatKm(ring.maxKm)})` : '')
        );
      } else if (ring.state === 'budget') {
        driveLines.push(`${ring.minutes} min — over free-tier routing budget`);
      } else if (ring.state === 'unavailable') {
        driveLines.push(`${ring.minutes} min — unavailable`);
      } else {
        driveLines.push(`${ring.minutes} min — ${ring.note || 'error'}`);
      }
    }
    if (drive.note) footnotes.push(drive.note);
  }

  return { flowLines, driveLines, footnotes };
}
