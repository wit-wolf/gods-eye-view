/**
 * Production Node server for Volo.
 *
 * Serves the Vite `dist/` build with SPA fallback, correct caching headers,
 * gzip/brotli compression, the shared `/api/*` proxies from `./routes.js`,
 * and `public/sites/*` (including `.geojson.gz` with identity transfer so the
 * client can decompress — see `src/sites/importKml.js` parseGzippedGeoJSON).
 *
 * Secrets come only from process.env (same names as the Vite dev server).
 * Never log API keys.
 *
 * @module server/index
 */

import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installApiRoutes } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC_SITES = path.join(ROOT, 'public', 'sites');

const PORT = Number.parseInt(process.env.PORT || '8080', 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * True when Accept-Encoding includes the named algorithm.
 * @param {import('express').Request} req
 * @param {string} encoding
 */
function acceptsEncoding(req, encoding) {
  const header = String(req.headers['accept-encoding'] || '');
  return header.split(',').some((part) => part.trim().toLowerCase().startsWith(encoding));
}

/**
 * Serve a precompressed sibling (file.br / file.gz) when the client accepts it.
 * Falls through so Express can serve the uncompressed asset otherwise.
 * @param {string} rootDir
 * @returns {import('express').RequestHandler}
 */
function precompressedStatic(rootDir) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rel = decodeURIComponent((req.path || '').replace(/^\//, ''));
    if (!rel || rel.includes('..')) return next();
    const abs = path.join(rootDir, rel);
    if (!abs.startsWith(rootDir)) return next();

    const tryFile = (candidate, encoding) => {
      if (!fs.existsSync(candidate)) return false;
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      // Let Express/send infer Content-Type from the uncompressed name.
      res.type(path.extname(rel) || 'application/octet-stream');
      // Hashed Vite assets are immutable; HTML handled elsewhere.
      if (/\.[a-f0-9]{8,}\./i.test(rel)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      res.sendFile(candidate, (err) => {
        if (err) next(err);
      });
      return true;
    };

    if (acceptsEncoding(req, 'br') && tryFile(`${abs}.br`, 'br')) return;
    if (acceptsEncoding(req, 'gzip') && tryFile(`${abs}.gz`, 'gzip')) return;
    return next();
  };
}

/**
 * Content-Type / encoding for `/sites/*.geojson.gz`.
 *
 * The client (`parseGzippedGeoJSON`) accepts either raw gzip bytes OR already-
 * inflated JSON. Vite's static middleware serves the file as an opaque body
 * without Content-Encoding (so `fetch().arrayBuffer()` still has the gzip
 * magic). We match that: application/geo+json (or octet-stream) and NO
 * Content-Encoding, so the browser does not auto-inflate before JS runs.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function serveSitesGzippedGeoJSON(req, res, next) {
  if (!req.path.endsWith('.geojson.gz')) return next();
  const rel = decodeURIComponent(req.path.replace(/^\//, ''));
  const abs = path.join(PUBLIC_SITES, rel);
  if (!abs.startsWith(PUBLIC_SITES) || !fs.existsSync(abs)) return next();
  res.setHeader('Content-Type', 'application/geo+json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // Intentionally omit Content-Encoding — body stays gzip-compressed on the wire
  // from the client's perspective (raw file bytes).
  res.sendFile(abs, (err) => {
    if (err) next(err);
  });
}

function createApp() {
  if (!fs.existsSync(DIST)) {
    console.error(`[volo] missing dist/ at ${DIST} — run \`npm run build\` first`);
    process.exit(1);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Dynamic gzip/brotli for API JSON and uncompressed static assets.
  app.use(compression({
    brotli: { enabled: true, zlib: {} },
    threshold: 1024,
    // Do not recompress bodies that are already encoded (e.g. .geojson.gz).
    filter: (req, res) => {
      if (res.getHeader('Content-Encoding')) return false;
      if (String(req.path || '').endsWith('.gz')) return false;
      return compression.filter(req, res);
    },
  }));

  // Shared /api/* proxies + /healthz (same as Vite dev).
  installApiRoutes(app);

  // Demo / uploaded site bundles from public/sites (not hashed into dist).
  app.use('/sites', serveSitesGzippedGeoJSON);
  app.use('/sites', express.static(PUBLIC_SITES, {
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.geojson.gz')) {
        res.setHeader('Content-Type', 'application/geo+json');
        // No Content-Encoding — see serveSitesGzippedGeoJSON.
        res.removeHeader('Content-Encoding');
      }
    },
  }));

  // Prefer precompressed Vite assets when present, then plain dist files.
  app.use(precompressedStatic(DIST));
  app.use(express.static(DIST, {
    index: false,
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'index.html') {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      // Vite emits content-hashed filenames for JS/CSS/assets.
      if (/\.[a-f0-9]{8,}\./i.test(base) || filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // SPA fallback — never cache the shell HTML.
  // Express 5 requires named wildcards (`/{*path}`); a trailing middleware is
  // simpler and version-agnostic.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || req.path === '/healthz') return next();
    if (req.path.startsWith('/sites/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  return app;
}

const app = createApp();
app.listen(PORT, HOST, () => {
  console.log(`[volo] listening on http://${HOST}:${PORT}`);
});
