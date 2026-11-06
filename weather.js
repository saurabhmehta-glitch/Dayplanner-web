const OPENWEATHER_BASE = 'https://api.openweathermap.org';

function json(res, status, data) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(data);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  let data = null;
  try { data = await response.json(); } catch { /* handled as an upstream error below */ }
  return { ok: response.ok, status: response.status, data };
}

function localDate(unixSeconds, timezoneOffsetSeconds) {
  return new Date((unixSeconds + timezoneOffsetSeconds) * 1000).toISOString().slice(0, 10);
}

export function buildForecast(items, date, timezoneOffsetSeconds) {
  const day = items.filter(item => localDate(item.dt, timezoneOffsetSeconds) === date);
  if (!day.length) return null;
  const temperatures = day.flatMap(item => [item.main?.temp_min, item.main?.temp_max, item.main?.temp].filter(Number.isFinite));
  if (!temperatures.length) return null;
  const noonSample = day.reduce((closest, item) => {
    const hour = new Date((item.dt + timezoneOffsetSeconds) * 1000).getUTCHours();
    const closestHour = new Date((closest.dt + timezoneOffsetSeconds) * 1000).getUTCHours();
    return Math.abs(hour - 12) < Math.abs(closestHour - 12) ? item : closest;
  });
  return {
    date,
    minTemperatureC: Math.round(Math.min(...temperatures)),
    maxTemperatureC: Math.round(Math.max(...temperatures)),
    condition: String(noonSample.weather?.[0]?.main || 'Unknown'),
    description: String(noonSample.weather?.[0]?.description || 'Forecast details unavailable'),
    precipitationChancePercent: Math.round(Math.max(0, ...day.map(item => Number(item.pop) || 0)) * 100)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { code: 'method_not_allowed', message: 'Use GET for weather.' });
  const destination = String(req.query?.destination || '').trim().slice(0, 150);
  const date = String(req.query?.date || '');
  if (!destination) return json(res, 400, { code: 'destination_required', message: 'Enter a destination to check its weather.' });
  if (!validDate(date)) return json(res, 400, { code: 'invalid_date', message: 'A valid trip date is required.' });
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return json(res, 503, { code: 'not_configured', message: 'Live weather is not configured for this deployment yet.' });

  try {
    const geocodeUrl = new URL('/geo/1.0/direct', OPENWEATHER_BASE);
    geocodeUrl.search = new URLSearchParams({ q: destination, limit: '5', appid: apiKey }).toString();
    const geocode = await getJson(geocodeUrl);
    if (!geocode.ok && geocode.status === 401) return json(res, 502, { code: 'invalid_api_key', message: 'OpenWeather rejected the key. Check it in your account; newly created keys can take up to two hours to activate.' });
    if (!geocode.ok || !Array.isArray(geocode.data)) return json(res, 502, { code: 'provider_unavailable', message: 'Weather lookup is temporarily unavailable.' });
    if (geocode.data.length === 0) return json(res, 404, { code: 'location_not_found', message: 'OpenWeather could not find that destination. Try adding a region or country.' });

    const locations = geocode.data;
    const regions = new Set(locations.map(location => `${location.name || ''}|${location.state || ''}|${location.country || ''}`));
    if (regions.size > 1) return json(res, 422, { code: 'ambiguous_location', message: 'This destination matches multiple places. Add a state or country and try again.' });
    const place = locations[0];
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return json(res, 502, { code: 'provider_unavailable', message: 'Weather lookup is temporarily unavailable.' });

    const params = new URLSearchParams({ lat: String(place.lat), lon: String(place.lon), appid: apiKey, units: 'metric' });
    const [currentResult, forecastResult] = await Promise.all([
      getJson(`${OPENWEATHER_BASE}/data/2.5/weather?${params}`),
      getJson(`${OPENWEATHER_BASE}/data/2.5/forecast?${params}`)
    ]);
    if (!currentResult.ok && currentResult.status === 401) return json(res, 502, { code: 'invalid_api_key', message: 'OpenWeather rejected the key. Check it in your account; newly created keys can take up to two hours to activate.' });
    if (!currentResult.ok || !Number.isFinite(currentResult.data?.main?.temp)) {
      return json(res, 502, { code: 'provider_unavailable', message: 'Current weather is temporarily unavailable.' });
    }

    const currentData = currentResult.data;
    const weather = currentData.weather?.[0] || {};
    const forecastData = forecastResult.ok && Array.isArray(forecastResult.data?.list) ? forecastResult.data : null;
    const timezoneOffset = Number(forecastData?.city?.timezone) || 0;
    const forecast = forecastData ? buildForecast(forecastData.list, date, timezoneOffset) : null;
    const hasTripDateSamples = Boolean(forecastData?.list.some(item => localDate(item.dt, timezoneOffset) === date));
    const snapshot = {
      location: [place.name, place.state, place.country].filter(Boolean).join(', '),
      current: {
        temperatureC: Math.round(currentData.main.temp),
        feelsLikeC: Math.round(Number(currentData.main.feels_like) || currentData.main.temp),
        humidityPercent: Number(currentData.main.humidity) || 0,
        windSpeedKph: Math.round((Number(currentData.wind?.speed) || 0) * 3.6),
        condition: String(weather.main || 'Unknown'),
        description: String(weather.description || 'Current conditions'),
        observedAt: new Date((Number(currentData.dt) || Date.now() / 1000) * 1000).toISOString()
      },
      forecast,
      forecastStatus: forecast ? 'available' : hasTripDateSamples || !forecastData ? 'unavailable' : 'outside-range',
      source: 'OpenWeather'
    };
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=300');
    return res.status(200).json(snapshot);
  } catch {
    return json(res, 502, { code: 'provider_unavailable', message: 'Weather is temporarily unavailable. Please try again.' });
  }
}
