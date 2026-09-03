import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

/**
 * Basemap / globe stacks for Volo.
 *
 * Google 2D Map Tiles (satellite / hybrid) use the existing GOOGLE_MAPS_API_KEY
 * via Cesium.Google2DImageryProvider — no Cesium ion token required.
 * Bing stacks still need CESIUM_ION_TOKEN and stay honestly unavailable without it.
 * Photoreal 3D tiles stay opt-in (heavy); cold start prefers Satellite 2D.
 */
export const MAP_STACKS = [
  {
    id: 'google-satellite',
    label: 'Satellite',
    shortLabel: 'Satellite',
    description: 'Google 2D satellite (Map Tiles API)',
    kind: 'google2d',
    mapType: 'satellite',
    requiresIon: false,
    requiresGoogle: true,
  },
  {
    id: 'osm',
    label: 'Streets',
    shortLabel: 'Streets',
    description: 'OpenStreetMap road map',
    kind: 'osm',
    requiresIon: false,
    requiresGoogle: false,
  },
  {
    id: 'google-hybrid',
    label: 'Satellite + labels',
    shortLabel: 'Hybrid',
    description: 'Google satellite with road labels',
    kind: 'google2d',
    mapType: 'satellite',
    // Baked hybrid (not a transparent overlay): satellite + roadmap labels.
    layerTypes: Object.freeze(['layerRoadmap']),
    overlay: false,
    requiresIon: false,
    requiresGoogle: true,
  },
  {
    id: 'photoreal',
    label: '3D buildings',
    shortLabel: '3D',
    description: 'Google Photorealistic 3D Tiles (heavy)',
    kind: 'photoreal',
    requiresIon: false,
    requiresGoogle: true,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial',
    shortLabel: 'Bing',
    description: 'Bing aerial imagery via Cesium ion',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL,
    requiresIon: true,
    requiresGoogle: false,
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels',
    shortLabel: 'Bing+',
    description: 'Bing aerial with labels via Cesium ion',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    requiresIon: true,
    requiresGoogle: false,
  },
];

/** Cold-start map source — Google 2D satellite when the Maps key works; else Streets. */
export const DEFAULT_MAP_STACK_ID = 'google-satellite';
export const FALLBACK_MAP_STACK_ID = 'osm';

const DEFAULT_OSM_CREDIT = '© OpenStreetMap contributors';

// Keyless global ellipsoidal terrain (Re:Earth Terrain / Mapterhorn, CC BY 4.0,
// EGM2008 geoid via NGA) — quantized-mesh 1.0, `ellipsoid` data-type. Fixes
// regime C (keyless globe stacks previously rendered a flat
// EllipsoidTerrainProvider — see the height-datum contract in docs/CURRENT-STATE.md
// §1a). Constructed via `.fromUrl()`, never a hand-built `{z}/{x}/{y}.terrain`
// URL (spec correction, spec §1a).
const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/**
 * Controls the active globe/map stack. Google Photorealistic 3D Tiles are an
 * opt-in DISPLAY toggle (performance); Google 2D satellite is the property default.
 */
export class MapStackController {
  constructor(viewer, {
    googleTileset = null,
    cesiumToken = '',
    googleApiKey = '',
    initialStack = DEFAULT_MAP_STACK_ID,
    onChange = null,
    onError = null,
  } = {}) {
    this.viewer = viewer;
    this.googleTileset = googleTileset;
    this.cesiumToken = String(cesiumToken || '').trim();
    this.googleApiKey = String(googleApiKey || '').trim()
      || String(globalThis?.window?.__GOOGLE_MAPS_API_KEY__ || '').trim()
      || String(Cesium.GoogleMaps?.defaultApiKey || '').trim();
    this._onChange = onChange;
    this._onError = onError;
    this._activeId = initialStack;
    this._imageryLayer = null;
    this._imageryProviders = new Map();
    this._isSwitching = false;
    this._lastError = null;
    // Tracks which terrain PROVIDER is actually installed on the scene, not
    // just an ion-available boolean: 'world' (Cesium World Terrain, ion
    // token), 'keyless' (Re:Earth or its Ellipsoid fallback), or null (never
    // set yet — Cesium's own startup default). Using a tri-state here (rather
    // than the `enabled` boolean `_setWorldTerrainEnabled` receives) matters
    // because both the "never set" and "keyless" states pass `enabled=false`;
    // collapsing them to a boolean would make the first real keyless switch
    // a no-op against the initial `false` default and leave Cesium's built-in
    // provider in place instead of installing Re:Earth terrain.
    this._terrainMode = null;
    // Cache of the constructed keyless Re:Earth CesiumTerrainProvider, so
    // repeat switches into a keyless globe stack don't refetch `layer.json`.
    // Lives independently of `_switchGen` — construction is async and racy
    // switches are guarded where it's awaited (`_setWorldTerrainEnabled`).
    this._reearthTerrainProvider = null;
    // Monotonic switch counter. setStack() awaits network-bound provider
    // creation; a rapid A→B switch where A (e.g. slow Bing) resolves AFTER B
    // (fast OSM) would otherwise revert the user's last choice (M7). Each call
    // captures a generation and aborts its own commit once superseded.
    this._switchGen = 0;

    if (!this.getStack(this._activeId) || !this.isStackAvailable(this._activeId)) {
      this._activeId = this.resolveDefaultStackId();
    }
  }

  /**
   * Cold-start preference: Satellite 2D when Google Map Tiles can run, else Streets.
   * Never defaults to 3D tiles.
   * @returns {string}
   */
  resolveDefaultStackId() {
    if (this.isStackAvailable(DEFAULT_MAP_STACK_ID)) return DEFAULT_MAP_STACK_ID;
    if (this.isStackAvailable(FALLBACK_MAP_STACK_ID)) return FALLBACK_MAP_STACK_ID;
    const first = this.getStacks().find((stack) => stack.available && stack.kind !== 'photoreal');
    return first?.id || FALLBACK_MAP_STACK_ID;
  }

  getStacks() {
    return MAP_STACKS.map((stack) => {
      const available = this.isStackAvailable(stack.id);
      return {
        ...stack,
        available,
        // Why this stack can't be picked, from the ONE place that decides it.
        // A stack can be unavailable for reasons other than a missing ion
        // token (photoreal is unavailable when the Google tileset failed to
        // load), so callers must not infer the reason from `available` alone.
        unavailableReason: available ? null : this._unavailableReason(stack),
      };
    });
  }

  /**
   * Human-readable reason a stack can't be activated. Shared by `getStacks()`
   * and `setStack()` so the tooltip and the toast never drift apart.
   * @param {object} stack - Stack descriptor.
   * @returns {string}
   */
  _unavailableReason(stack) {
    if (stack?.kind === 'photoreal') {
      return 'Google Photorealistic 3D Tiles unavailable';
    }
    if (stack?.requiresGoogle) {
      return 'GOOGLE_MAPS_API_KEY required (Map Tiles API)';
    }
    if (stack?.requiresIon) {
      return 'Cesium ion token required for Bing stacks';
    }
    return `${stack?.label || 'This map stack'} is unavailable`;
  }

  getStack(id) {
    return MAP_STACKS.find((stack) => stack.id === id) || null;
  }

  getActiveId() {
    return this._activeId;
  }

  /**
   * Monotonic id of the most recently STARTED switch.
   *
   * A switch is only superseded by another `setStack()` — nothing else moves
   * this number — so a caller that must know whether the globe it is looking
   * at is still the one IT asked for can compare this across its own await.
   * Unchanged (or advanced by exactly its own call) means no newer switch has
   * claimed the globe.
   * @returns {number}
   */
  getSwitchGeneration() {
    return this._switchGen;
  }

  getActiveStack() {
    return this.getStack(this._activeId);
  }

  isStackAvailable(id) {
    const stack = this.getStack(id);
    if (!stack) return false;
    if (stack.kind === 'photoreal') return !!this.googleTileset;
    if (stack.kind === 'google2d') {
      return !!this.googleApiKey && typeof Cesium.Google2DImageryProvider?.fromUrl === 'function';
    }
    if (stack.requiresIon) return !!this.cesiumToken;
    return true;
  }

  async setStack(id, { silent = false } = {}) {
    const stack = this.getStack(id)
      || this.getStack(this.resolveDefaultStackId())
      || this.getStack(FALLBACK_MAP_STACK_ID)
      || this.getStack('photoreal');
    if (!stack) return null;

    if (!this.isStackAvailable(stack.id)) {
      const message = this._unavailableReason(stack);
      this._lastError = message;
      this._onError?.(message, stack);
      return this.getState();
    }

    const gen = ++this._switchGen;
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');

    try {
      if (stack.kind === 'photoreal') {
        await this._activatePhotoreal(gen);
      } else {
        await this._activateGlobeStack(stack, gen);
      }
      // A newer switch started while we were awaiting the provider — that call
      // owns the final state now, so don't commit ours or emit a stale 'ready'.
      if (gen !== this._switchGen) return this.getState();
      this._activeId = stack.id;
      // Show/hide of tilesets + imagery swaps need a frame in idle mode;
      // subsequent tile loads self-request via Cesium. (perf wave 2)
      governorRequestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, stack);
      const fallbackId = this.resolveDefaultStackId();
      if (fallbackId && fallbackId !== stack.id && this.isStackAvailable(fallbackId)) {
        try {
          const fallback = this.getStack(fallbackId);
          if (fallback?.kind === 'photoreal') {
            await this._activatePhotoreal(gen);
          } else if (fallback) {
            await this._activateGlobeStack(fallback, gen);
          }
          if (gen !== this._switchGen) return this.getState();
          this._activeId = fallbackId;
        } catch {
          // Keep prior active id; error already reported.
        }
      }
      if (!silent) this._emitChange('error');
    } finally {
      // Only the latest switch clears the switching flag; a superseded call
      // must not stomp a newer switch that is still in progress.
      if (gen === this._switchGen) this._isSwitching = false;
    }

    return this.getState();
  }

  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
      hasCesiumIonToken: !!this.cesiumToken,
      hasGoogleMapsApiKey: !!this.googleApiKey,
    };
  }

  async _activatePhotoreal(gen) {
    this._removeImageryLayer();
    if (this.googleTileset) this.googleTileset.show = true;
    this.viewer.scene.globe.show = false;
    // Terrain is left UNTOUCHED here. The photoreal globe is hidden
    // (`globe.show = false`), so the terrain provider is inert — it renders and
    // streams nothing. Routing this through `_setWorldTerrainEnabled(false)`
    // would make the DEFAULT startup stack await a keyless Re:Earth `layer.json`
    // fetch it can't use, delaying photoreal boot on a slow/blocked network and
    // (on failure) caching the flat `EllipsoidTerrainProvider` fallback for
    // later OSM switches. The Re:Earth fetch is therefore lazy: it happens on
    // the first switch to an actual globe stack (`_activateGlobeStack`).
    // `_terrainMode` is intentionally not changed — every globe-stack transition
    // re-derives the correct provider from it (null/'world'/'keyless'), so
    // leaving it as-is keeps the next switch correct without a photoreal fetch.
    void gen;
  }

  async _activateGlobeStack(stack, gen) {
    const provider = await this._getImageryProvider(stack);
    // A newer switch started while the provider was resolving — don't touch the
    // scene's imagery layers, the winning switch already owns them (M7).
    if (gen != null && gen !== this._switchGen) return;
    this._removeImageryLayer();

    this._imageryLayer = new Cesium.ImageryLayer(provider);
    this.viewer.imageryLayers.add(this._imageryLayer, 0);

    if (this.googleTileset) this.googleTileset.show = false;
    this.viewer.scene.globe.show = true;
    await this._setWorldTerrainEnabled(!!this.cesiumToken, gen);
  }

  async _getImageryProvider(stack) {
    if (this._imageryProviders.has(stack.id)) {
      return this._imageryProviders.get(stack.id);
    }

    let provider;
    if (stack.kind === 'ion') {
      provider = await Cesium.createWorldImageryAsync({ style: stack.style });
    } else if (stack.kind === 'google2d') {
      provider = await this._createGoogle2dProvider(stack);
    } else if (stack.kind === 'osm') {
      provider = new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: DEFAULT_OSM_CREDIT,
      });
    } else {
      throw new Error(`Unsupported map stack: ${stack.id}`);
    }

    this._imageryProviders.set(stack.id, provider);
    return provider;
  }

  /**
   * Google Map Tiles 2D session + imagery provider.
   * Hybrid uses satellite + layerRoadmap with overlay:false (baked labels).
   * @param {object} stack
   * @returns {Promise<Cesium.ImageryProvider>}
   */
  async _createGoogle2dProvider(stack) {
    const key = this.googleApiKey;
    if (!key) throw new Error('GOOGLE_MAPS_API_KEY required for Google 2D satellite');

    // Cesium.fromUrl only supports plain satellite/roadmap/terrain or a
    // transparent overlayLayerType. Hybrid (satellite + labels as one basemap)
    // needs an explicit createSession with overlay:false + layerTypes.
    if (Array.isArray(stack.layerTypes) && stack.layerTypes.length) {
      return this._createGoogle2dHybridProvider(stack, key);
    }

    return Cesium.Google2DImageryProvider.fromUrl({
      key,
      mapType: stack.mapType || 'satellite',
      language: 'en-US',
      region: 'ZA',
    });
  }

  /**
   * @param {object} stack
   * @param {string} key
   */
  async _createGoogle2dHybridProvider(stack, key) {
    const endpoint = String(Cesium.GoogleMaps?.mapTilesApiEndpoint || 'https://tile.googleapis.com/');
    const baseUrl = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
    const response = await fetch(`${baseUrl}v1/createSession?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapType: stack.mapType || 'satellite',
        language: 'en-US',
        region: 'ZA',
        layerTypes: [...stack.layerTypes],
        overlay: stack.overlay === true,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Google Map Tiles session failed (${response.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    const sessionJson = await response.json();
    const session = sessionJson?.session;
    const tileWidth = sessionJson?.tileWidth || 256;
    const tileHeight = sessionJson?.tileHeight || 256;
    if (!session) throw new Error('Google Map Tiles session missing token');

    return new Cesium.Google2DImageryProvider({
      url: baseUrl,
      key,
      session,
      tileWidth,
      tileHeight,
      credit: Cesium.GoogleMaps?.getDefaultCredit?.() || '© Google',
    });
  }

  _removeImageryLayer() {
    if (!this._imageryLayer) return;
    this.viewer.imageryLayers.remove(this._imageryLayer, false);
    this._imageryLayer = null;
  }

  /**
   * Sets the scene's terrain provider for the current globe stack.
   *
   * `enabled` selects Cesium World Terrain (ion token present — regime B,
   * unchanged). Disabled/keyless (regime C: OSM or any globe stack without an
   * ion token) now tries the keyless Re:Earth ellipsoidal terrain instead of
   * the flat `EllipsoidTerrainProvider`, falling back to the flat provider
   * (today's behavior) if construction fails — no worse than before this fix.
   *
   * `CesiumTerrainProvider.fromUrl()` is async (fetches `layer.json`), so this
   * method is async-safe: `gen` is the caller's switch generation (from
   * `setStack`'s `_switchGen`, threaded through `_activatePhotoreal` /
   * `_activateGlobeStack`, mirroring the M7 pattern in `_activateGlobeStack`
   * for imagery providers). If a newer switch starts while the Re:Earth
   * fetch is in flight, this call's result is discarded instead of
   * clobbering the newer switch's terrain.
   * @param {boolean} enabled
   * @param {number} [gen] — switch generation this call belongs to
   */
  async _setWorldTerrainEnabled(enabled, gen) {
    const targetMode = enabled ? 'world' : 'keyless';
    if (targetMode === this._terrainMode) return;
    if (enabled) {
      this.viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain({
        requestVertexNormals: true,
      }));
    } else {
      const provider = await this._getKeylessTerrainProvider();
      // A newer switch started while the Re:Earth layer.json fetch was in
      // flight — that call owns terrain now; don't stomp it (M7 pattern).
      if (gen != null && gen !== this._switchGen) return;
      this.viewer.terrainProvider = provider;
    }
    this._terrainMode = targetMode;
  }

  /**
   * Resolves (and caches) the keyless terrain provider for globe stacks
   * without an ion token: Re:Earth ellipsoidal quantized-mesh terrain, or
   * `EllipsoidTerrainProvider` (flat — current/prior behavior) if the
   * Re:Earth endpoint can't be constructed. Never throws.
   * @returns {Promise<Cesium.TerrainProvider>}
   */
  async _getKeylessTerrainProvider() {
    if (this._reearthTerrainProvider) return this._reearthTerrainProvider;
    try {
      this._reearthTerrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
    } catch (error) {
      console.warn('[mapStackController] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:', error);
      this._reearthTerrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
    return this._reearthTerrainProvider;
  }

  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }
}
