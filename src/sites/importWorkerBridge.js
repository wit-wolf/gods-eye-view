/**
 * Main-thread bridge to sitesImport.worker.js (cancellable KMZ/KML parse).
 */

let _worker = null;
let _seq = 0;

function getWorker() {
  if (_worker) return _worker;
  if (typeof Worker === 'undefined') return null;
  _worker = new Worker(new URL('./sitesImport.worker.js', import.meta.url), {
    type: 'module',
  });
  return _worker;
}

/**
 * Parse a file off the main thread when Workers are available.
 * Falls back to the shared importKml helpers on the main thread (tests / SSR).
 * @param {object} options
 * @param {ArrayBuffer} options.buffer
 * @param {string} options.filename
 * @param {string} options.layerId
 * @param {AbortSignal} [options.signal]
 * @param {function({phase:string,ratio:number}):void} [options.onProgress]
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function importFileInWorker({
  buffer,
  filename,
  layerId,
  signal,
  onProgress,
}) {
  const worker = getWorker();
  if (!worker) {
    const {
      importAndProcessFile,
    } = await import('./importKml.js');
    const blob = new Blob([buffer]);
    const file = new File([blob], filename);
    onProgress?.({ phase: 'parsing', ratio: 0.5 });
    const geojson = await importAndProcessFile(file, layerId);
    onProgress?.({ phase: 'done', ratio: 1 });
    return geojson;
  }

  if (signal?.aborted) {
    const error = new Error('Sites import cancelled');
    error.name = 'AbortError';
    throw error;
  }

  const id = `import-${++_seq}`;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const error = new Error('Sites import cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    const onMessage = (event) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === 'progress') {
        onProgress?.({ phase: msg.phase, ratio: msg.ratio });
        return;
      }
      if (msg.type === 'done') {
        cleanup();
        resolve(msg.geojson);
        return;
      }
      if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message || 'Import worker failed'));
      }
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, buffer, filename, layerId }, [buffer]);
  });
}
