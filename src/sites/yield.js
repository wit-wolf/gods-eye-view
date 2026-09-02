/**
 * Cooperative scheduling helpers so Sites import / paint never monopolizes
 * the main thread. Prefer requestIdleCallback; fall back to rAF + timeout.
 */

/**
 * Yield to the browser so input + paint can run.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs=32] Idle timeout budget.
 * @returns {Promise<void>}
 */
export function yieldToMain({ signal, timeoutMs = 32 } = {}) {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const done = () => {
      cleanup();
      if (signal?.aborted) reject(abortError());
      else resolve();
    };

    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(() => done(), { timeout: timeoutMs });
      signal?.addEventListener?.('abort', () => {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id);
      }, { once: true });
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(done, 0));
      return;
    }

    setTimeout(done, 0);
  });
}

function abortError() {
  const error = new Error('Sites import cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * Run `work` over `items` in batches, yielding between batches.
 * @template T
 * @param {T[]} items
 * @param {object} options
 * @param {number} [options.batchSize=120]
 * @param {AbortSignal} [options.signal]
 * @param {function(T[], number, number): (void|Promise<void>)} options.work
 * @param {function({done:number,total:number}): void} [options.onProgress]
 */
export async function mapInBatches(items, {
  batchSize = 120,
  signal,
  work,
  onProgress,
  idleTimeoutMs = 32,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const size = Math.max(1, Math.floor(batchSize) || 120);
  const yieldMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
    ? idleTimeoutMs
    : 32;
  for (let i = 0; i < total; i += size) {
    if (signal?.aborted) throw abortError();
    const batch = list.slice(i, i + size);
    await work(batch, i, total);
    onProgress?.({ done: Math.min(i + batch.length, total), total });
    if (i + size < total) await yieldToMain({ signal, timeoutMs: yieldMs });
  }
}

/**
 * Prefer features near Cape Town, then stride-sample the remainder.
 * @param {object[]} features
 * @param {number} [limit=500]
 * @returns {object[]}
 */
export function sampleFeaturesForPreview(features, limit = 500) {
  const list = Array.isArray(features) ? features : [];
  const cap = Math.max(0, Math.floor(limit) || 0);
  if (list.length <= cap) return list.slice();

  const inCapeTown = [];
  const others = [];
  for (const feature of list) {
    if (isNearCapeTown(feature)) inCapeTown.push(feature);
    else others.push(feature);
  }

  const out = [];
  for (const feature of inCapeTown) {
    if (out.length >= cap) break;
    out.push(feature);
  }
  if (out.length >= cap) return out;

  const need = cap - out.length;
  const stride = Math.max(1, Math.floor(others.length / need));
  for (let i = 0; i < others.length && out.length < cap; i += stride) {
    out.push(others[i]);
  }
  return out;
}

function isNearCapeTown(feature) {
  const c = primaryCoord(feature);
  if (!c) return false;
  const [lon, lat] = c;
  return lon > 18.2 && lon < 18.9 && lat > -34.5 && lat < -33.5;
}

function primaryCoord(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates?.[0]?.[0];
  if (g.type === 'LineString') return g.coordinates?.[0];
  if (g.type === 'MultiPoint') return g.coordinates?.[0];
  if (g.type === 'MultiPolygon') return g.coordinates?.[0]?.[0]?.[0];
  return null;
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}
