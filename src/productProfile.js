/**
 * Eagle Eye by Volee — property globe product surface (not an OSINT spy console).
 *
 * Cut feeds stay in the codebase (proxies, modules, share-token catalog) so they
 * can be re-enabled later. They must not register, start, or appear in the HUD
 * while this profile is active.
 */

/** @typedef {'voice'|'radio'|'cctv'|'detection'|'intelClassification'|'militaryVisualStyles'|'cockpitContacts'|'models3d'|'hudOpenAiSummary'|'contactsContext'|'spaceMissionsContext'} ProductFeature */

/**
 * Single source of truth for user-facing product chrome.
 * Repo / GitHub slug may still say gods-eye-view; do not rename the repository.
 */
export const PRODUCT_BRANDING = Object.freeze({
  productLine: 'Eagle Eye',
  company: 'Volee',
  /** Full product name — titles, README, HUD. */
  productName: 'Eagle Eye by Volee',
  shortName: 'Eagle Eye',
  tagline: 'No place left behind',
  documentTitle: 'Eagle Eye by Volee',
  /** Compact title-bar / loader mark (accent applied in markup). */
  titleMark: 'EAGLE EYE',
  titleCompanyLine: 'by Volee',
  hudClassification: 'EAGLE EYE · BY VOLEE',
  hudSystemLine: 'EAGLE EYE  SITE VIEW',
  hudTopCenter: 'EAGLE EYE',
  hudTopRight: 'SITE',
  firstRunKicker: 'EAGLE EYE · BY VOLEE',
  firstRunDescription:
    'Photoreal sites, weather, and fires on one globe—for property work, not a spy console.',
  firstRunTip: 'Tip: open Data Layers for Sites, traffic, and FIRMS fires.',
  /** Property viewing starts without the circular scope mask. */
  scopeEnabledByDefault: false,
});

/**
 * Layers Werner kept for property / tenant-rep work on the photoreal globe.
 * Fires (NASA FIRMS) and traffic/roads matter for site access; infrastructure
 * local layers help SA due diligence. Aircraft, ships, sats, CCTV, radio stay out.
 */
export const VOLEE_ENABLED_LAYER_IDS = Object.freeze([
  'sites',
  'traffic',
  'local-firms',
  'earthquakes',
  'local-datacenters',
  'local-dams',
  'telegeography-submarine-cables',
]);

/** Cut from the product surface (do not register / start / show controls). */
export const VOLEE_CUT_LAYER_IDS = Object.freeze([
  'flights',
  'military',
  'military-awareness',
  'military-installations',
  'ais-live-vessels',
  'satellites',
  'rocket-launches',
  'cctv',
  'radio',
  'bikeshare',
]);

/**
 * Visual preset `data-style` values that read as stacked intel theatre.
 * Weather/fire presentation lives on layers + cockpit WX, not these shaders.
 */
export const VOLEE_CUT_VISUAL_STYLES = Object.freeze([
  'retro',
  'surveillance',
  'thermal',
  'anime',
  'noir',
  'snow',
]);

export const PRODUCT_PROFILE = Object.freeze({
  id: 'volee',
  /** Body class applied at boot for CSS chrome gates. */
  bodyClass: 'product-volee',
  branding: PRODUCT_BRANDING,
  enabledLayerIds: VOLEE_ENABLED_LAYER_IDS,
  cutLayerIds: VOLEE_CUT_LAYER_IDS,
  cutVisualStyles: VOLEE_CUT_VISUAL_STYLES,
  /**
   * Location search is hard-biased to South Africa so “George” is Western Cape,
   * not Utah. Browser Places Autocomplete uses `includedRegionCodes: ["za"]`;
   * Text Search uses `regionCode: "ZA"`. (Geocoding REST cannot use the
   * referrer-restricted Maps key that powers 3D tiles.)
   */
  search: Object.freeze({
    countryCode: 'ZA',
    regionCodes: Object.freeze(['za']),
    placeholder: 'Search South Africa…',
  }),
  features: Object.freeze({
    voice: false,
    radio: false,
    cctv: false,
    detection: false,
    intelClassification: false,
    militaryVisualStyles: false,
    cockpitContacts: false,
    models3d: false,
    hudOpenAiSummary: false,
    contactsContext: false,
    spaceMissionsContext: false,
  }),
});

const ENABLED_SET = new Set(PRODUCT_PROFILE.enabledLayerIds);

/** @param {string} layerId */
export function isProductLayerEnabled(layerId) {
  return ENABLED_SET.has(layerId);
}

/** @param {ProductFeature} feature */
export function isProductFeatureEnabled(feature) {
  return PRODUCT_PROFILE.features[feature] === true;
}

/**
 * Filter the share-token catalog down to layers this product registers.
 * @param {ReadonlyArray<{id: string}>} catalog
 */
export function filterLayerStateRegistryForProduct(catalog) {
  return Object.freeze(
    (catalog || []).filter((entry) => entry && isProductLayerEnabled(entry.id)),
  );
}

/**
 * Hide cut chrome and stamp the product body class. Idempotent.
 * @param {Document} [documentRef]
 * @param {typeof PRODUCT_PROFILE} [profile]
 */
export function applyProductChrome(documentRef = globalThis.document, profile = PRODUCT_PROFILE) {
  const doc = documentRef;
  const body = doc?.body;
  if (!body) return;

  body.classList.add(profile.bodyClass);
  body.dataset.product = profile.id;

  const brand = profile.branding || PRODUCT_BRANDING;
  if (doc.title !== undefined) doc.title = brand.documentTitle;

  const titleBar = doc.getElementById('title-bar');
  if (titleBar) {
    const h1 = titleBar.querySelector('h1');
    if (h1) {
      const textSpan = [...h1.querySelectorAll(':scope > span')].find((el) => (
        !el.classList?.contains?.('title-logo') && !el.classList?.contains?.('brand-logo')
      ));
      if (textSpan) textSpan.textContent = brand.titleMark;
    }
    const subtitle = titleBar.querySelector('.subtitle');
    if (subtitle) subtitle.textContent = brand.titleCompanyLine;
  }

  const loader = doc.getElementById('loading-screen');
  if (loader) {
    const loaderTitle = loader.querySelector('h2');
    if (loaderTitle) loaderTitle.textContent = brand.titleMark;
  }

  const selectors = [];
  if (!profile.features.cctv) selectors.push('#cctv-panel');
  if (!profile.features.radio) {
    selectors.push('#radio-panel', '#cockpit-radio-dock', '[data-cockpit-radio]');
    // Compact radio lives inside the cockpit utility strip.
    selectors.push('#cockpit-radio-toggle-btn', '#cockpit-radio-panel');
    selectors.push('#context-radio-details-btn');
  }
  if (!profile.features.detection) {
    selectors.push('#detection-toggle');
    selectors.push('#detection-slider-row', '#detection-allocation-row');
    selectors.push('#detection-fade-row', '#detection-opacity-row');
  }
  if (!profile.features.models3d) {
    selectors.push('#models3d-toggle', '#models3d-mode-row');
  }
  if (!profile.features.contactsContext) {
    selectors.push('#global-context-flights-btn', '#context-flights-view');
  }
  if (!profile.features.spaceMissionsContext) {
    selectors.push('#global-context-missions-btn', '#context-missions-view');
  }
  if (!profile.features.militaryVisualStyles) {
    for (const style of profile.cutVisualStyles) {
      selectors.push(`#style-buttons [data-style="${style}"]`);
    }
  }
  if (!profile.features.voice) {
    selectors.push('#gev-voice-controls', '[data-gev-voice]');
  }

  for (const selector of selectors) {
    for (const el of doc.querySelectorAll(selector)) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      el.classList.add('product-surface-cut');
    }
  }

  // First-run: drop spy missions; keep environmental + explore; add Sites.
  const launcher = doc.getElementById('first-run-launcher');
  if (launcher) {
    const kicker = launcher.querySelector('.first-run-kicker');
    if (kicker) kicker.textContent = brand.firstRunKicker;
    const description = launcher.querySelector('#first-run-description');
    if (description) {
      description.textContent = brand.firstRunDescription;
    }
    const tip = launcher.querySelector('[data-first-run-status]');
    if (tip && (/MIC button/i.test(tip.textContent || '') || /Data Layers/i.test(tip.textContent || ''))) {
      tip.textContent = brand.firstRunTip;
    }
    for (const choice of ['contacts', 'space-missions']) {
      const btn = launcher.querySelector(`[data-first-run-choice="${choice}"]`);
      if (btn) {
        btn.hidden = true;
        btn.setAttribute('aria-hidden', 'true');
        btn.classList.add('product-surface-cut');
      }
    }
    // Ensure a Sites mission tile exists (inserted before environmental).
    if (!launcher.querySelector('[data-first-run-choice="sites"]')) {
      const choices = launcher.querySelector('.first-run-choices');
      const environmental = choices?.querySelector('[data-first-run-choice="environmental"]');
      if (choices && environmental) {
        const sitesBtn = doc.createElement('button');
        sitesBtn.type = 'button';
        sitesBtn.dataset.firstRunChoice = 'sites';
        sitesBtn.innerHTML = [
          '<span class="material-symbols-outlined" aria-hidden="true">location_on</span>',
          '<span><strong>SITES</strong><small>Import KMZ pins or load the November demo</small></span>',
          '<span class="material-symbols-outlined first-run-arrow" aria-hidden="true">arrow_forward</span>',
        ].join('');
        choices.insertBefore(sitesBtn, environmental);
      }
    }
  }

  // Context panel without Contacts/Space should not dominate — collapse standby copy.
  if (!profile.features.contactsContext && !profile.features.spaceMissionsContext) {
    const contextPanel = doc.getElementById('global-context-panel');
    if (contextPanel) {
      contextPanel.hidden = true;
      contextPanel.setAttribute('aria-hidden', 'true');
      contextPanel.classList.add('product-surface-cut');
    }
  }
}
