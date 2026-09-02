const MAX_ARTICLES = 5;
const AREA_NEWS_MAX_ARTICLES = 10;

/** Retail-biased keywords for Area News ranking (title match). */
export const AREA_NEWS_RETAIL_TERMS = Object.freeze([
  'retail', 'retailer', 'shopping', 'mall', 'centre', 'center', 'leasing',
  'tenant', 'consumer', 'supermarket', 'grocery', 'fashion', 'store',
  'stores', 'shop', 'shops', 'outlet', 'hypermarket', 'spar', 'checkers',
  'woolworths', 'pick n pay', 'pick n\' pay', 'mr price', 'foschini',
  'cashbuild', 'builders', 'dis-chem', 'clicks', 'game', 'makro',
]);

/** Broader business keywords (after retail). */
export const AREA_NEWS_BUSINESS_TERMS = Object.freeze([
  'business', 'economy', 'economic', 'company', 'corporate', 'investment',
  'property', 'commercial', 'market', 'markets', 'finance', 'financial',
  'trade', 'industry', 'earnings', 'revenue', 'expansion', 'development',
]);

function cleanText(value, maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Google News locale params — ZA preference for South Africa property work.
 * @param {{countryCode?:string|null}} [place]
 * @returns {{hl:string, gl:string, ceid:string}}
 */
export function newsLocaleForPlace(place) {
  const code = String(place?.countryCode || '').toUpperCase();
  if (code === 'ZA') return { hl: 'en-ZA', gl: 'ZA', ceid: 'ZA:en' };
  return { hl: 'en-US', gl: 'US', ceid: 'US:en' };
}

/**
 * Classify a headline into retail / business / other for Area News ordering.
 * @param {string} title
 * @returns {'retail'|'business'|'other'}
 */
export function classifyAreaNewsTopic(title) {
  const text = String(title || '').toLowerCase();
  if (!text) return 'other';
  if (AREA_NEWS_RETAIL_TERMS.some((term) => text.includes(term))) return 'retail';
  if (AREA_NEWS_BUSINESS_TERMS.some((term) => text.includes(term))) return 'business';
  return 'other';
}

/**
 * Build retail-then-business Google/GDELT query strings from a place label.
 * @param {{locality?:string|null, region?:string|null, country?:string|null, label?:string|null}} place
 * @returns {Array<{topic:'retail'|'business', query:string}>}
 */
export function buildAreaNewsSearchQueries(place) {
  const focus = cleanText(
    place?.locality || place?.region || place?.label || place?.country,
    90,
  );
  if (!focus) return [];
  const quoted = `"${focus.replace(/["\\]/g, ' ').trim()}"`;
  return [
    {
      topic: 'retail',
      query: `${quoted} (retail OR shopping OR mall OR leasing OR supermarket OR "shopping centre" OR "shopping center" OR consumer OR tenant)`,
    },
    {
      topic: 'business',
      query: `${quoted} (business OR economy OR property OR commercial OR investment OR company OR corporate OR development)`,
    },
  ];
}

/**
 * Rank articles retail → business → other, preserving relative order within band.
 * @param {Array<object>} articles
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function rankAndLimitAreaNews(articles, limit = AREA_NEWS_MAX_ARTICLES) {
  const rows = Array.isArray(articles) ? articles : [];
  const scored = rows.map((article, index) => {
    const topic = article?.topic || classifyAreaNewsTopic(article?.title);
    const rank = topic === 'retail' ? 0 : topic === 'business' ? 1 : 2;
    return { article: { ...article, topic }, rank, index };
  });
  scored.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  const max = Math.max(1, Math.min(AREA_NEWS_MAX_ARTICLES, limit));
  return scored.slice(0, max).map((row) => row.article);
}

/** Normalize a Nominatim reverse-geocode response into cockpit-sized place context. */
export function normalizeRegionalPlace(payload) {
  const address = payload?.address || {};
  const locality = cleanText(
    address.city || address.town || address.village || address.municipality
      || address.hamlet || address.county,
    90,
  );
  const region = cleanText(address.state || address.region || address.county, 90);
  const country = cleanText(address.country, 90);
  const label = [locality, region].filter((value, index, values) => value && values.indexOf(value) === index)
    .join(', ') || country || cleanText(payload?.display_name, 120);
  if (!label) return null;
  return {
    label,
    locality: locality || null,
    region: region || null,
    country: country || null,
    countryCode: cleanText(address.country_code, 4).toUpperCase() || null,
  };
}

/** Normalize and deduplicate GDELT ArticleList output without trusting article HTML. */
export function normalizeRegionalArticles(payload, limit = MAX_ARTICLES) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  const seen = new Set();
  const articles = [];
  const max = Math.max(1, Math.min(AREA_NEWS_MAX_ARTICLES, limit));
  for (const row of rows) {
    const url = safeHttpUrl(row?.url || row?.url_mobile);
    const title = cleanText(row?.title, 180);
    if (!url || !title) continue;
    const signature = `${title.toLowerCase()}|${new URL(url).hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = cleanText(row?.seendate, 32);
    const compactDate = /^(\d{8})T(\d{6})Z$/.exec(rawDate);
    const publishedAt = compactDate
      ? `${compactDate[1].slice(0, 4)}-${compactDate[1].slice(4, 6)}-${compactDate[1].slice(6, 8)}T${compactDate[2].slice(0, 2)}:${compactDate[2].slice(2, 4)}:${compactDate[2].slice(4, 6)}Z`
      : Number.isNaN(Date.parse(rawDate)) ? null : new Date(rawDate).toISOString();
    articles.push({
      title,
      url,
      domain: cleanText(row?.domain || new URL(url).hostname.replace(/^www\./, ''), 80),
      publishedAt,
      sourceCountry: cleanText(row?.sourcecountry, 60) || null,
      topic: classifyAreaNewsTopic(title),
    });
    if (articles.length >= max) break;
  }
  return articles;
}

/** Normalize Open-Meteo current conditions into a small source-stamped record. */
export function normalizeRegionalWeather(payload) {
  const current = payload?.current;
  if (!current || !Number.isFinite(Number(current.temperature_2m))) return null;
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  // Open-Meteo reports zone-naive timestamps ("2026-08-17T00:15") that are UTC,
  // but JS parses zoneless date-times as LOCAL — pin them to UTC explicitly.
  const observedRaw = typeof current.time === 'string' && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(current.time)
    ? `${current.time}Z`
    : current.time;
  return {
    observedAt: Number.isNaN(Date.parse(observedRaw)) ? null : new Date(observedRaw).toISOString(),
    temperatureC: numberOrNull(current.temperature_2m),
    apparentTemperatureC: numberOrNull(current.apparent_temperature),
    precipitationMm: numberOrNull(current.precipitation),
    cloudCoverPct: numberOrNull(current.cloud_cover),
    windKph: numberOrNull(current.wind_speed_10m),
    windDirectionDeg: numberOrNull(current.wind_direction_10m),
    visibilityM: numberOrNull(current.visibility),
    weatherCode: numberOrNull(current.weather_code),
  };
}

/** Translate the WMO weather code used by Open-Meteo into concise cockpit copy. */
export function weatherCodeLabel(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return 'CONDITIONS UNKNOWN';
  if (value === 0) return 'CLEAR';
  if ([1, 2].includes(value)) return 'PARTLY CLOUDY';
  if (value === 3) return 'OVERCAST';
  if ([45, 48].includes(value)) return 'FOG';
  if (value >= 51 && value <= 57) return 'DRIZZLE';
  if (value >= 61 && value <= 67) return 'RAIN';
  if (value >= 71 && value <= 77) return 'SNOW';
  if (value >= 80 && value <= 82) return 'RAIN SHOWERS';
  if (value >= 85 && value <= 86) return 'SNOW SHOWERS';
  if (value >= 95) return 'THUNDERSTORM';
  return 'MIXED CONDITIONS';
}

/** Great-circle distance used to avoid refetching a regional brief every animation frame. */
export function regionalDistanceM(from, to) {
  if (![from?.latitude, from?.longitude, to?.latitude, to?.longitude].every(Number.isFinite)) {
    return Infinity;
  }
  const phi1 = from.latitude * Math.PI / 180;
  const phi2 = to.latitude * Math.PI / 180;
  const deltaPhi = (to.latitude - from.latitude) * Math.PI / 180;
  const deltaLambda = (to.longitude - from.longitude) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Fetch a bounded regional brief through the same-origin dev/preview proxy.
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal, mode?:'default'|'area-news'}} [opts]
 */
export async function fetchRegionalBrief(latitude, longitude, { signal, mode = 'default' } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) throw new Error('Valid coordinates are required');
  const params = new URLSearchParams({
    latitude: latitude.toFixed(5),
    longitude: longitude.toFixed(5),
  });
  if (mode === 'area-news') params.set('mode', 'area-news');
  const response = await fetch(`/api/regional-brief?${params}`, { signal });
  if (!response.ok) throw new Error(`Regional brief unavailable (${response.status})`);
  return response.json();
}

/**
 * Relative age label for Area News / cockpit brief lines.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatAreaNewsAge(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'date unknown';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export { AREA_NEWS_MAX_ARTICLES, MAX_ARTICLES as COCKPIT_NEWS_MAX_ARTICLES };
