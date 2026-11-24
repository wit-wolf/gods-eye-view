# Deploy Volo (single container)

Volo ships as one Node process that serves the Vite `dist/` build and the same
`/api/*` proxies used in local development (`server/routes.js`). Target runtime:
Azure Container Apps (ACA), or any host that runs an OCI image on port 8080.

This guide does **not** deploy anything for you — it documents build/run locally
and the env surface ACA needs.

## Local: production server (no Docker)

```bash
# Build-time client embeds (optional for a smoke test without maps)
export GOOGLE_MAPS_API_KEY=...   # baked into the JS bundle
export CESIUM_ION_TOKEN=...      # optional; Bing/terrain stacks

npm ci
npm run build
npm start                        # listens on PORT (default 8080)
```

Smoke checks:

```bash
curl -sS http://127.0.0.1:8080/healthz
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
curl -sS -D- -o /dev/null http://127.0.0.1:8080/sites/november_pins.geojson.gz | head
curl -sS http://127.0.0.1:8080/api/tomtom/status
# → {"hasKey":false,...} when TOMTOM_API_KEY is unset (graceful)
```

## Local: Docker

```bash
docker build \
  --build-arg GOOGLE_MAPS_API_KEY="$GOOGLE_MAPS_API_KEY" \
  --build-arg CESIUM_ION_TOKEN="$CESIUM_ION_TOKEN" \
  -t volo:local .

docker run --rm -p 8080:8080 \
  -e TOMTOM_API_KEY \
  -e FIRMS_MAP_KEY \
  -e OPENAI_API_KEY \
  -e AISSTREAM_API_KEY \
  -e OPENSKY_CLIENT_ID \
  -e OPENSKY_CLIENT_SECRET \
  volo:local
```

Image defaults: `PORT=8080`, `HOST=0.0.0.0`, non-root user, `/healthz` probe.

## Build args (client-side, compile time)

These are embedded in the browser bundle by Vite `define` / `import.meta.env`.
They are **not** secret from the client — restrict them in the provider consoles.

| Build arg | Used for |
|-----------|----------|
| `GOOGLE_MAPS_API_KEY` | Photorealistic 3D Tiles + Places (browser) |
| `CESIUM_ION_TOKEN` | Optional Cesium ion imagery/terrain (browser) |

Standard Vite `VITE_*` variables (if set at build time) are also available to
the client in the usual way — e.g. `VITE_AIS_LIVE_API_URL`,
`VITE_AIS_LIVE_MAX_ROWS` (see `.env.example`). Prefer baking defaults into the
image only when they are non-secret tuning knobs.

**Google Maps:** add the deployed HTTPS origin (and `http://localhost:8080` for
local container tests) as an **HTTP referrer** restriction on the key. Map Tiles
API + Places API (New) must be enabled.

## Runtime env vars (server-side secrets)

Set these on the Container App (or `docker run -e`). Names match the Vite
dev server. **Never** commit `.env`. **Never** log key values.

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `PORT` | no (default `8080`) | Listen port |
| `HOST` | no (default `0.0.0.0`) | Bind address |
| `TOMTOM_API_KEY` | no | Live traffic + Sites routing/search proxies |
| `TOMTOM_DAILY_TILE_BUDGET` | no | Soft daily tile cap (default 40000) |
| `TOMTOM_DAILY_ROUTE_BUDGET` | no | Soft daily route/search cap (default 800) |
| `FIRMS_MAP_KEY` | no | NASA FIRMS active-fire proxy |
| `AISSTREAM_API_KEY` | no | Live AIS websocket broker |
| `OPENSKY_AUTH_MODE` | no | `oauth` / `basic` / `auto` / `anon` |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | no | OpenSky OAuth |
| `OPENAI_API_KEY` | no | Realtime voice / HUD summary (if enabled) |
| `LL2_API_TOKEN` | no | Launch Library 2 authenticated quota |
| `GEV_RATELIMIT_GOOGLE_PER_MIN` | no | Optional per-IP Places throttle |
| `GEV_RATELIMIT_OPENAI_PER_MIN` | no | Optional per-IP OpenAI throttle |

Full list and comments: `.env.example`.

## Suggested Azure Container Apps sizing

| Setting | Suggestion |
|---------|------------|
| vCPU | `0.25` |
| Memory | `0.5Gi` |
| Min replicas | `1` (keep warm so `/api/*` caches + AIS socket stay useful) |
| Max replicas | start at `3`, raise with traffic |
| Ingress | external HTTPS, target port `8080` |
| Health probe | HTTP `GET /healthz` |

Scale out is fine for the static shell; in-memory proxy caches and the AIS
websocket are **per replica** (not shared). Prefer min replicas `1` unless you
accept cold starts and reconnect churn.

## What the container serves

- `/` — SPA (`dist/index.html`, `Cache-Control: no-cache`)
- `/assets/*` — hashed Vite assets (long-cache immutable)
- `/sites/*` — `public/sites` (`.geojson.gz` kept as raw gzip bytes without
  `Content-Encoding`, matching what `parseGzippedGeoJSON` expects)
- `/api/*` — same proxies as `npm run dev`
- `/healthz` — `{ "ok": true }`

## Security notes

- Do not put server secrets in build args or `VITE_*` names.
- Restrict `GOOGLE_MAPS_API_KEY` by HTTP referrer to the ACA hostname.
- Restrict `CESIUM_ION_TOKEN` by URL if using ion.
- The production server brokers keyed upstreams; treat the ACA ingress as a
  trusted edge (auth / IP filter / Front Door) if the app is not public.
