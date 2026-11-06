import { useEffect, useState } from 'react';
import { AlertCircle, CloudRain, CloudSun, Droplets, RotateCcw, Thermometer, Wind } from 'lucide-react';
import type { WeatherSnapshot } from '../types';

type WeatherState = { loading: true; data: null; error: '' } | { loading: false; data: WeatherSnapshot | null; error: string };

function isWeatherSnapshot(value: unknown): value is WeatherSnapshot {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<WeatherSnapshot>;
  return typeof x.location === 'string' && x.source === 'OpenWeather' && !!x.current &&
    Number.isFinite(x.current.temperatureC) && Number.isFinite(x.current.feelsLikeC) &&
    Number.isFinite(x.current.humidityPercent) && Number.isFinite(x.current.windSpeedKph) &&
    typeof x.current.condition === 'string' && typeof x.current.description === 'string' &&
    typeof x.current.observedAt === 'string' &&
    (x.forecastStatus === 'available' || x.forecastStatus === 'outside-range' || x.forecastStatus === 'unavailable') &&
    (x.forecast === null || (!!x.forecast && typeof x.forecast.date === 'string' &&
      Number.isFinite(x.forecast.minTemperatureC) && Number.isFinite(x.forecast.maxTemperatureC) &&
      Number.isFinite(x.forecast.precipitationChancePercent) && typeof x.forecast.condition === 'string' &&
      typeof x.forecast.description === 'string'));
}

function friendlyError(code: string | undefined, message: string | undefined) {
  if (code === 'static_demo') return 'Live weather is available in the hosted app. The local static demo does not use an API key.';
  if (code === 'not_configured') return 'Live weather has not been configured for this deployment yet.';
  if (code === 'ambiguous_location') return message || 'Add a region or country to make the destination more specific.';
  return message || 'Weather could not be loaded right now. Please try again.';
}

export default function WeatherCard({ destination, date }: { destination: string; date: string }) {
  const [state, setState] = useState<WeatherState>({ loading: true, data: null, error: '' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, data: null, error: '' });
    const query = new URLSearchParams({ destination, date });
    fetch(`/api/weather?${query}`, { signal: controller.signal })
      .then(async response => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const errorBody = body as { code?: string; message?: string } | null;
          throw new Error(friendlyError(errorBody?.code, errorBody?.message));
        }
        if (!isWeatherSnapshot(body)) throw new Error('Weather returned an unexpected response. Please retry.');
        setState({ loading: false, data: body, error: '' });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setState({ loading: false, data: null, error: error instanceof Error ? error.message : 'Weather could not be loaded. Please retry.' });
      });
    return () => controller.abort();
  }, [destination, date, retry]);

  const current = state.data?.current;
  const forecast = state.data?.forecast;
  const weatherIcon = /rain|drizzle|thunder|snow/i.test(`${forecast?.condition || ''} ${current?.condition || ''}`) ? CloudRain : CloudSun;
  const ConditionIcon = weatherIcon;

  return <section className="sidebar-card weather-card" aria-live="polite">
    <div className="sidebar-card-head weather-head"><div><div className="eyebrow">LIVE CONDITIONS · OPENWEATHER</div><h3>Weather around your day</h3></div>
      <button className="icon-btn weather-refresh" onClick={() => setRetry(value => value + 1)} disabled={state.loading} aria-label="Refresh weather" title="Refresh weather"><RotateCcw size={15}/></button>
    </div>
    {state.loading ? <div className="weather-loading"><span className="spinner"/><span>Checking weather near {destination}…</span></div> : null}
    {!state.loading && state.error ? <div className="weather-error"><AlertCircle size={18}/><div><b>Weather unavailable</b><p>{state.error}</p><button onClick={() => setRetry(value => value + 1)}>Try again <RotateCcw size={12}/></button></div></div> : null}
    {!state.loading && state.data && current ? <>
      <div className="weather-current"><ConditionIcon size={31}/><div className="weather-temp">{current.temperatureC}°<small>C</small></div><div className="weather-description"><b>{current.condition}</b><span>{current.description}</span><small>{state.data.location}</small></div></div>
      <div className="weather-metrics"><div><Thermometer size={14}/><span><small>FEELS LIKE</small><b>{current.feelsLikeC}°C</b></span></div><div><Droplets size={14}/><span><small>HUMIDITY</small><b>{current.humidityPercent}%</b></span></div><div><Wind size={14}/><span><small>WIND</small><b>{current.windSpeedKph} km/h</b></span></div></div>
      {forecast ? <div className="weather-forecast"><div className="forecast-title"><span>YOUR TRIP · {new Date(`${forecast.date}T12:00:00`).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}).toUpperCase()}</span><b>{forecast.minTemperatureC}° – {forecast.maxTemperatureC}°C</b></div><div className="forecast-detail"><span>{forecast.condition} · {forecast.description}</span><span><CloudRain size={13}/> {forecast.precipitationChancePercent}% rain chance</span></div></div> : <p className="forecast-unavailable">{state.data.forecastStatus === 'outside-range' ? 'Trip-date forecast is outside OpenWeather’s 5-day forecast window. Current conditions above are for now.' : 'Trip-date forecast is temporarily unavailable. Current conditions above are for now.'}</p>}
      <div className="weather-updated">Observed {new Date(current.observedAt).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})} · °C and km/h</div>
    </> : null}
  </section>;
}
