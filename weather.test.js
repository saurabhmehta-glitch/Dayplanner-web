import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { buildForecast } from '../api/weather.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENWEATHER_API_KEY;
const secret = 'test-openweather-secret';

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENWEATHER_API_KEY;
  else process.env.OPENWEATHER_API_KEY = originalKey;
});

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(query = {}) { return { method: 'GET', query }; }
function upstream(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function localUnix(date, hour, timezoneOffsetSeconds) {
  return Date.UTC(Number(date.slice(0,4)), Number(date.slice(5,7))-1, Number(date.slice(8,10)), hour) / 1000 - timezoneOffsetSeconds;
}

test('requires destination and a valid trip date', async () => {
  process.env.OPENWEATHER_API_KEY = secret;
  const missing = responseRecorder();
  await handler(request({ date: '2026-06-11' }), missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, 'destination_required');

  const badDate = responseRecorder();
  await handler(request({ destination: 'Tokyo', date: '2026-02-30' }), badDate);
  assert.equal(badDate.statusCode, 400);
  assert.equal(badDate.body.code, 'invalid_date');
});

test('reports that the server-side key is not configured without exposing secrets', async () => {
  delete process.env.OPENWEATHER_API_KEY;
  const res = responseRecorder();
  await handler(request({ destination: 'Tokyo', date: '2026-06-11' }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'not_configured');
  assert.doesNotMatch(JSON.stringify(res.body), /secret/i);
});

test('reports missing and ambiguous geocoded locations', async () => {
  process.env.OPENWEATHER_API_KEY = secret;
  globalThis.fetch = async () => upstream([]);
  const missing = responseRecorder();
  await handler(request({ destination: 'Nowhere', date: '2026-06-11' }), missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.code, 'location_not_found');

  globalThis.fetch = async () => upstream([
    { name: 'Springfield', state: 'Illinois', country: 'US', lat: 39.78, lon: -89.64 },
    { name: 'Springfield', state: 'Missouri', country: 'US', lat: 37.21, lon: -93.29 }
  ]);
  const ambiguous = responseRecorder();
  await handler(request({ destination: 'Springfield', date: '2026-06-11' }), ambiguous);
  assert.equal(ambiguous.statusCode, 422);
  assert.equal(ambiguous.body.code, 'ambiguous_location');
  assert.doesNotMatch(JSON.stringify(ambiguous.body), new RegExp(secret));
});

test('sanitizes an upstream authentication error', async () => {
  process.env.OPENWEATHER_API_KEY = secret;
  globalThis.fetch = async () => upstream({ message: `invalid key ${secret}` }, 401);
  const res = responseRecorder();
  await handler(request({ destination: 'Tokyo', date: '2026-06-11' }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'invalid_api_key');
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(secret));
});

test('returns a sanitized error when the current-weather provider fails', async () => {
  process.env.OPENWEATHER_API_KEY = secret;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/geo/1.0/direct') return upstream([{ name: 'Oslo', country: 'NO', lat: 59.91, lon: 10.75 }]);
    if (url.pathname === '/data/2.5/weather') return upstream({ message: `upstream error ${secret}` }, 503);
    if (url.pathname === '/data/2.5/forecast') return upstream({ list: [] });
    throw new Error('Unexpected OpenWeather URL');
  };
  const res = responseRecorder();
  await handler(request({ destination: 'Oslo', date: '2026-06-11' }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'provider_unavailable');
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(secret));
});

test('returns current weather and the forecast grouped by destination-local date', async () => {
  process.env.OPENWEATHER_API_KEY = secret;
  const offset = 5.5 * 60 * 60;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/geo/1.0/direct') return upstream([{ name: 'Pune', state: 'Maharashtra', country: 'IN', lat: 18.52, lon: 73.85 }]);
    if (url.pathname === '/data/2.5/weather') return upstream({ dt: 1781150400, main: { temp: 30.2, feels_like: 32.1, humidity: 60 }, wind: { speed: 2.5 }, weather: [{ main: 'Clouds', description: 'scattered clouds' }] });
    if (url.pathname === '/data/2.5/forecast') return upstream({ city: { timezone: offset }, list: [
      { dt: localUnix('2026-06-11', 9, offset), main: { temp: 20, temp_min: 18, temp_max: 23 }, pop: 0.2, weather: [{ main: 'Clouds', description: 'cloudy' }] },
      { dt: localUnix('2026-06-11', 13, offset), main: { temp: 25, temp_min: 22, temp_max: 29 }, pop: 0.8, weather: [{ main: 'Rain', description: 'light rain' }] }
    ] });
    throw new Error('Unexpected OpenWeather URL');
  };
  const res = responseRecorder();
  await handler(request({ destination: 'Pune', date: '2026-06-11' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'OpenWeather');
  assert.equal(res.body.current.temperatureC, 30);
  assert.equal(res.body.current.windSpeedKph, 9);
  assert.equal(res.body.forecastStatus, 'available');
  assert.equal(res.body.forecast.date, '2026-06-11');
  assert.equal(res.body.forecast.minTemperatureC, 18);
  assert.equal(res.body.forecast.maxTemperatureC, 29);
  assert.equal(res.body.forecast.precipitationChancePercent, 80);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(secret));
});

test('keeps current weather when the trip date is outside the forecast window', async () => {
  process.env.OPENWEATHER_API_KEY = secret;
  const offset = 0;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/geo/1.0/direct') return upstream([{ name: 'London', country: 'GB', lat: 51.5, lon: -0.1 }]);
    if (url.pathname === '/data/2.5/weather') return upstream({ dt: 1781150400, main: { temp: 17, feels_like: 16, humidity: 50 }, wind: { speed: 3 }, weather: [{ main: 'Clear', description: 'clear sky' }] });
    if (url.pathname === '/data/2.5/forecast') return upstream({ city: { timezone: offset }, list: [{
      dt: localUnix('2026-06-11', 12, offset), main: { temp: 17, temp_min: 15, temp_max: 20 }, pop: 0.1, weather: [{ main: 'Clear', description: 'clear sky' }]
    }] });
    throw new Error('Unexpected OpenWeather URL');
  };
  const res = responseRecorder();
  await handler(request({ destination: 'London', date: '2026-06-20' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.current.temperatureC, 17);
  assert.equal(res.body.forecast, null);
  assert.equal(res.body.forecastStatus, 'outside-range');
});

test('returns no forecast sample when the requested local date has no forecast records', () => {
  const result = buildForecast([{ dt: localUnix('2026-06-11', 9, 19800), main: { temp: 20, temp_min: 18, temp_max: 22 }, weather: [] }], '2026-06-12', 19800);
  assert.equal(result, null);
});
