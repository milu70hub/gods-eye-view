import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsToViewbox,
  installKeylessGeocodeMiddleware,
  nominatimHitToResult,
  nominatimTypesToGoogle,
} from '../server/keylessGeocode.js';

test('Nominatim types map onto the Google types the navigation-mode heuristic reads', () => {
  assert.deepEqual(nominatimTypesToGoogle({ class: 'boundary', type: 'administrative', addresstype: 'country' }), ['country', 'political']);
  assert.deepEqual(nominatimTypesToGoogle({ class: 'place', type: 'city', addresstype: 'city' }), ['locality', 'political']);
  assert.deepEqual(nominatimTypesToGoogle({ class: 'place', type: 'town' }), ['locality', 'political']);
  assert.deepEqual(nominatimTypesToGoogle({ class: 'highway', type: 'residential', addresstype: 'road' }), ['route']);
  assert.deepEqual(nominatimTypesToGoogle({ class: 'natural', type: 'peak' }), ['natural_feature']);
  assert.deepEqual(nominatimTypesToGoogle({ class: 'tourism', type: 'attraction' }), ['establishment', 'point_of_interest']);
});

test('a Nominatim hit becomes a Google-shaped result with location and viewport', () => {
  const result = nominatimHitToResult({
    lat: '38.7223', lon: '-9.1393', display_name: 'Lisboa, Portugal', place_id: 42,
    boundingbox: ['38.6913', '38.7958', '-9.2298', '-9.0863'], class: 'boundary', type: 'administrative', addresstype: 'city',
  });
  assert.equal(result.formatted_address, 'Lisboa, Portugal');
  assert.deepEqual(result.geometry.location, { lat: 38.7223, lng: -9.1393 });
  assert.deepEqual(result.geometry.viewport, { southwest: { lat: 38.6913, lng: -9.2298 }, northeast: { lat: 38.7958, lng: -9.0863 } });
  assert.deepEqual(result.types, ['locality', 'political']);
  assert.equal(nominatimHitToResult({ lat: 'x', lon: '1' }), null);
});

test('Google-order bounds become a Nominatim viewbox', () => {
  assert.equal(boundsToViewbox('38.6,-9.3|38.8,-9.0'), '-9.3,38.8,-9.0,38.6');
  assert.equal(boundsToViewbox('garbage'), null);
  assert.equal(boundsToViewbox(''), null);
});

function fakeApp() {
  const routes = new Map();
  return { use: (path, handler) => routes.set(path, handler), routes };
}
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (payload) => { res.body = payload; };
  return res;
}

test('/api/geocode proxies Nominatim with the policy headers and answers in Google shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify([{ lat: '38.7223', lon: '-9.1393', display_name: 'Lisboa, Portugal', boundingbox: ['38.69', '38.79', '-9.22', '-9.08'], class: 'place', type: 'city' }]), { status: 200 });
  };
  const app = fakeApp();
  installKeylessGeocodeMiddleware(app, { fetchImpl });
  const handler = app.routes.get('/api/geocode');
  const res = fakeRes();
  await handler({ method: 'GET', url: '/?q=Lisboa&bounds=38.6,-9.3|38.8,-9.0' }, res);
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.status, 'OK');
  assert.equal(payload.results[0].geometry.location.lat, 38.7223);
  assert.match(calls[0].url, /nominatim\.openstreetmap\.org\/search\?/);
  assert.match(calls[0].url, /q=Lisboa/);
  assert.match(calls[0].url, /viewbox=-9\.3%2C38\.8%2C-9\.0%2C38\.6/);
  assert.match(calls[0].headers['User-Agent'], /GodsEyeView/);
  // cached: a second identical query does not hit upstream
  const res2 = fakeRes();
  await handler({ method: 'GET', url: '/?q=Lisboa&bounds=38.6,-9.3|38.8,-9.0' }, res2);
  assert.equal(calls.length, 1);
  const bad = fakeRes();
  await handler({ method: 'GET', url: '/?q=' }, bad);
  assert.equal(bad.statusCode, 400);
  const post = fakeRes();
  await handler({ method: 'POST', url: '/?q=x' }, post);
  assert.equal(post.statusCode, 405);
});
