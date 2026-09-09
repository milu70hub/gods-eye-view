/**
 * Keyless forward geocoding for fly_to_location (September 2026).
 *
 * Without a Google Maps key, "take me to Lisbon" used to throw
 * ("No Google Maps API key available for geocoding") so voice and typed
 * navigation only worked for the eight preset cities. This proxy answers
 * `GET /api/geocode?q=<place>[&bounds=<s>,<w>|<n>,<e>]` from Nominatim
 * (OpenStreetMap) and returns the same shape the client already parses for
 * Google Geocoding (`status`, `results[0].geometry.location/viewport`,
 * `formatted_address`, `types`), so `searchAndFlyTo` keeps one code path.
 *
 * Nominatim usage policy: max 1 request/second, identifying User-Agent, no
 * heavy use. The queue below serializes requests at ≥1.1 s and the response
 * is cached per query for 10 minutes.
 */

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_CHARS = 200;

let queue = Promise.resolve();
let lastRequestAt = 0;
const cache = new Map();

/** Map Nominatim class/type/addresstype to the Google-style types the client's navigation-mode heuristic understands. */
export function nominatimTypesToGoogle(hit) {
  const cls = String(hit?.class || '').toLowerCase();
  const type = String(hit?.type || '').toLowerCase();
  const addressType = String(hit?.addresstype || '').toLowerCase();
  const key = addressType || type;
  if (key === 'country') return ['country', 'political'];
  if (['state', 'region', 'province'].includes(key)) return ['administrative_area_level_1', 'political'];
  if (['county', 'state_district', 'district'].includes(key)) return ['administrative_area_level_2', 'political'];
  if (['city', 'town', 'village', 'municipality', 'hamlet', 'borough', 'city_district'].includes(key)) return ['locality', 'political'];
  if (['suburb', 'neighbourhood', 'quarter', 'residential', 'postcode'].includes(key)) return ['neighborhood', 'political'];
  if (cls === 'highway' || ['road', 'street', 'pedestrian'].includes(key)) return ['route'];
  if (['park', 'garden', 'nature_reserve', 'national_park'].includes(key) || cls === 'leisure') return ['park'];
  if (['aerodrome', 'airport'].includes(key)) return ['airport'];
  if (['university', 'college'].includes(key)) return ['university'];
  if (key === 'stadium') return ['stadium'];
  if (cls === 'natural' || cls === 'water' || cls === 'waterway' || ['peak', 'mountain_range', 'sea', 'bay', 'beach', 'island'].includes(key)) return ['natural_feature'];
  return ['establishment', 'point_of_interest'];
}

/** Nominatim hit → Google Geocoding-shaped result. */
export function nominatimHitToResult(hit) {
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const box = Array.isArray(hit.boundingbox) ? hit.boundingbox.map(Number) : [];
  const viewport = box.length === 4 && box.every(Number.isFinite)
    ? { southwest: { lat: box[0], lng: box[2] }, northeast: { lat: box[1], lng: box[3] } }
    : { southwest: { lat: lat - 0.01, lng: lng - 0.01 }, northeast: { lat: lat + 0.01, lng: lng + 0.01 } };
  return {
    formatted_address: String(hit.display_name || hit.name || '').trim(),
    geometry: { location: { lat, lng }, viewport },
    types: nominatimTypesToGoogle(hit),
    place_id: hit.place_id != null ? String(hit.place_id) : undefined,
    source: 'nominatim',
  };
}

/** `bounds=s,w|n,e` (Google order) → Nominatim `viewbox=w,n,e,s`. */
export function boundsToViewbox(bounds) {
  const match = /^(-?[\d.]+),(-?[\d.]+)\|(-?[\d.]+),(-?[\d.]+)$/.exec(String(bounds || '').trim());
  if (!match) return null;
  const [s, w, n, e] = match.slice(1);
  if (![s, w, n, e].every((v) => Number.isFinite(Number(v)))) return null;
  return `${w},${n},${e},${s}`;
}

async function nominatimSearch(query, { viewbox = null, fetchImpl = fetch, lang = 'en' } = {}) {
  const cacheKey = `${query}|${viewbox || ''}|${lang}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.at > Date.now() - CACHE_TTL_MS) return cached.value;
  const task = queue.then(async () => {
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', addressdetails: '0', 'accept-language': lang });
    if (viewbox) params.set('viewbox', viewbox); // soft bias, not bounded
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetchImpl(`${NOMINATIM_SEARCH}?${params}`, {
        headers: { 'User-Agent': USER_AGENT, Referer: 'https://github.com/bilawalsidhu/gods-eye-view' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Nominatim ${response.status}`);
      const hits = await response.json();
      const result = Array.isArray(hits) && hits.length ? nominatimHitToResult(hits[0]) : null;
      const value = result ? { status: 'OK', results: [result] } : { status: 'ZERO_RESULTS', results: [] };
      cache.set(cacheKey, { at: Date.now(), value });
      return value;
    } finally {
      clearTimeout(timer);
    }
  });
  queue = task.catch(() => null);
  return task;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('connect').Server} middlewares
 * @param {{ fetchImpl?: typeof fetch, lang?: string }} [options]
 */
export function installKeylessGeocodeMiddleware(middlewares, { fetchImpl = fetch, lang = 'en' } = {}) {
  middlewares.use('/api/geocode', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { status: 'ERROR', error: 'Method not allowed' });
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { status: 'ERROR', error: 'Bad URL' });
    }
    const query = String(url.searchParams.get('q') || '').trim().slice(0, MAX_QUERY_CHARS);
    if (!query) return sendJson(res, 400, { status: 'ERROR', error: 'q required' });
    const viewbox = boundsToViewbox(url.searchParams.get('bounds'));
    try {
      const payload = await nominatimSearch(query, { viewbox, fetchImpl, lang });
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 502, { status: 'ERROR', error: String(error?.message || error).slice(0, 200) });
    }
  });
}
