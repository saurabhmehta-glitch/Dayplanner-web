import { buildForecast } from '../api/weather.js';

const OSM_AGENT = 'DaytripPlanner/1.0 (local travel planning demo)';
const json = (res, status, body) => res.status(status).setHeader('Cache-Control','no-store').json(body);
const finite = value => Number.isFinite(Number(value));
const safeSource = item => ({ title: String(item.title || 'Travel research').slice(0,180), url: String(item.url || ''), ...(item.published_date ? { publishedAt: String(item.published_date).slice(0,40) } : {}) });

function validPreferences(p) {
  if (!p || typeof p !== 'object' || typeof p.start !== 'string' || !p.start.trim() || typeof p.destination !== 'string' ||
    typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !finite(p.adults) || p.adults < 1 ||
    !finite(p.children) || p.children < 0 || p.adults + p.children > 30 || !finite(p.budget) || p.budget <= 0 ||
    !['group','person'].includes(p.budgetBasis) || !Array.isArray(p.interests) || !p.interests.length ||
    !Array.isArray(p.transport) || !p.transport.length || typeof p.depart !== 'string' || typeof p.return !== 'string') return false;
  const time = value => { const match = /^(\d{2}):(\d{2})$/.exec(value); return match ? Number(match[1])*60+Number(match[2]) : NaN; };
  return time(p.return)-time(p.depart) >= 240;
}

async function fetchJson(url, options = {}, timeout = 12000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.json();
}

async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ format:'jsonv2', limit:'1', q:query }).toString();
  const rows = await fetchJson(url, { headers:{ 'User-Agent': OSM_AGENT, 'Accept-Language':'en' } });
  const row = rows?.[0];
  if (!row || !finite(row.lat) || !finite(row.lon)) return null;
  return { lat:Number(row.lat), lon:Number(row.lon), displayName:String(row.display_name || query) };
}

function categoryFor(tags = {}) {
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe') return 'Food & rest';
  if (tags.leisure === 'park' || tags.natural) return 'Nature';
  if (tags.historic) return 'History & culture';
  if (tags.tourism === 'museum') return 'Museum';
  if (tags.tourism === 'viewpoint') return 'Viewpoint';
  return 'Attraction';
}

async function findNearby(center, radiusMeters = 18000) {
  const radius = Math.max(1000, Math.min(100000, Math.floor(radiusMeters)));
  const q = `[out:json][timeout:15];(node(around:${radius},${center.lat},${center.lon})[name][tourism~"attraction|museum|viewpoint|zoo|theme_park"];way(around:${radius},${center.lat},${center.lon})[name][tourism~"attraction|museum|viewpoint|zoo|theme_park"];node(around:${radius},${center.lat},${center.lon})[name][historic];way(around:${radius},${center.lat},${center.lon})[name][historic];node(around:${radius},${center.lat},${center.lon})[name][leisure=park];way(around:${radius},${center.lat},${center.lon})[name][leisure=park];node(around:${radius},${center.lat},${center.lon})[name][amenity~"cafe|restaurant"];);out center tags 60;`;
  const data = await fetchJson('https://overpass-api.de/api/interpreter', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'User-Agent':OSM_AGENT }, body:`data=${encodeURIComponent(q)}` }, 22000);
  const seen = new Set();
  return (data.elements || []).map(el => {
    const point = el.center || el, tags = el.tags || {}, name = String(tags.name || '').trim();
    return { name, category:categoryFor(tags), lat:Number(point.lat), lon:Number(point.lon), source:'OpenStreetMap' };
  }).filter(place => place.name && finite(place.lat) && finite(place.lon) && Math.abs(place.lat)<=90 && Math.abs(place.lon)<=180 && !seen.has(place.name.toLocaleLowerCase()) && seen.add(place.name.toLocaleLowerCase())).slice(0,60);
}

function haversine(a,b) {
  const rad = n => n*Math.PI/180, dLat=rad(b.lat-a.lat), dLon=rad(b.lon-a.lon);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}

export async function placesHandler(req,res) {
  if (req.method !== 'GET') return json(res,405,{ code:'method_not_allowed', message:'Use GET for place lookup.' });
  const destination=String(req.query?.destination || '').trim().slice(0,150);
  if (!destination) return json(res,400,{ code:'destination_required', message:'Enter a destination or starting location.' });
  let center;
  try {
    center=await geocode(destination);
    if (!center) return json(res,404,{ code:'location_not_found', message:'OpenStreetMap could not find that location.' });
  } catch { return json(res,502,{ code:'places_unavailable', message:'OpenStreetMap place lookup is temporarily unavailable.' }); }
  try {
    const places=await findNearby(center, Number(req.query?.radius) || 18000);
    return json(res,200,{ center, places, placesStatus:'available', source:'OpenStreetMap' });
  } catch {
    // A failed POI service must not prevent the map from using its verified geocoded center.
    return json(res,200,{ center, places:[], placesStatus:'unavailable', source:'OpenStreetMap' });
  }
}

export async function routeHandler(req,res) {
  if (req.method !== 'POST') return json(res,405,{ code:'method_not_allowed', message:'Use POST for route lookup.' });
  const profile=String(req.body?.profile || 'driving');
  const points=req.body?.points;
  if (profile !== 'driving') return json(res,422,{ code:'profile_unavailable', message:'Verified routes are currently available for driving only.' });
  if (!Array.isArray(points) || points.length < 2 || points.length > 10 || points.some(p => !finite(p?.lat) || !finite(p?.lon) || Math.abs(p.lat)>90 || Math.abs(p.lon)>180))
    return json(res,400,{ code:'invalid_points', message:'Route lookup needs 2–10 verified coordinates.' });
  try {
    const coords=points.map(p=>`${Number(p.lon)},${Number(p.lat)}`).join(';');
    const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
    const data=await fetchJson(url,{},15000);
    const route=data.routes?.[0];
    if (data.code !== 'Ok' || !route || !finite(route.distance) || !finite(route.duration) || route.geometry?.type!=='LineString' || !Array.isArray(route.geometry.coordinates))
      return json(res,502,{ code:'route_unavailable', message:'No verified driving route was returned.' });
    return json(res,200,{ distanceKm:route.distance/1000, durationMinutes:route.duration/60, geometry:route.geometry, source:'OSRM', verified:true });
  } catch { return json(res,502,{ code:'route_unavailable', message:'Driving routes are temporarily unavailable.' }); }
}

async function tavilyResearch(p, destination) {
  const key=process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const body={ query:`Travel guide ${destination} near ${p.start}; ${p.interests.slice(0,5).join(', ')}. Find useful source references.`, search_depth:'basic', max_results:5, include_answer:false };
    const data=await fetchJson('https://api.tavily.com/search',{ method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' }, body:JSON.stringify(body) },10000);
    return (Array.isArray(data.results)?data.results:[]).filter(x=>typeof x.url==='string' && /^https?:\/\//i.test(x.url)).slice(0,5).map(safeSource);
  } catch { return []; }
}

async function weatherContext(destination, date) {
  const key=process.env.OPENWEATHER_API_KEY;
  if (!key) return { status:'unavailable', note:'No forecast is configured.' };
  try {
    const loc=await fetchJson(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(destination)}&limit=1&appid=${encodeURIComponent(key)}`);
    if (!loc?.[0]) return { status:'unavailable', note:'No matching forecast location.' };
    const u=new URL('https://api.openweathermap.org/data/2.5/forecast');
    u.search=new URLSearchParams({lat:String(loc[0].lat),lon:String(loc[0].lon),appid:key,units:'metric'}).toString();
    const data=await fetchJson(u);
    const forecast=buildForecast(data.list || [],date,Number(data.city?.timezone)||0);
    if (!forecast) return { status:'outside-range', note:'The selected date is outside the available forecast window; do not infer conditions.' };
    const warning=forecast.precipitationChancePercent>=60 || /rain|storm|snow/i.test(forecast.condition);
    return { status:'available', note:`${forecast.condition}: ${forecast.minTemperatureC}–${forecast.maxTemperatureC}°C; precipitation chance ${forecast.precipitationChancePercent}%.${warning?' Prioritize indoor alternatives.':''}`, ...forecast };
  } catch { return { status:'unavailable', note:'Forecast lookup failed; do not infer conditions.' }; }
}

function outputValid(x) {
  return x && typeof x.title==='string' && Array.isArray(x.stops) && x.stops.length>0 && x.stops.length<=7 &&
    x.stops.every(s=>s && typeof s.name==='string' && typeof s.category==='string' && typeof s.arrival==='string' && typeof s.departure==='string' && typeof s.description==='string' && Number.isFinite(s.duration) && Number.isFinite(s.entryCostPerPerson) && Number.isFinite(s.activityCostPerPerson)) &&
    x.budget && ['transportation','food','tickets','activities','parking','miscellaneous'].every(k=>Number.isFinite(x.budget[k]) && x.budget[k]>=0) && Array.isArray(x.tips);
}

function timeIn(value) { const m=/^(\d{2}):(\d{2})$/.exec(value||''); return m?Number(m[1])*60+Number(m[2]):NaN; }
function scheduleValid(stops, depart, ret) {
  let cursor=timeIn(depart), limit=timeIn(ret);
  if (!Number.isFinite(cursor)||!Number.isFinite(limit)) return false;
  for (const s of stops) { const a=timeIn(s.arrival), b=timeIn(s.departure); if (!Number.isFinite(a)||!Number.isFinite(b)||a<cursor||b<=a||b>limit) return false; cursor=b; }
  return cursor<=limit;
}
function routeScheduleValid(stops, legs, depart, ret) {
  if (!scheduleValid(stops,depart,ret) || !Array.isArray(legs) || legs.length < stops.length+1) return false;
  let earliest=timeIn(depart);
  for (let i=0;i<stops.length;i++) {
    if (!finite(legs[i]?.duration)) return false;
    earliest+=Number(legs[i].duration)/60;
    if (timeIn(stops[i].arrival)<earliest) return false;
    earliest=timeIn(stops[i].departure);
  }
  return earliest+Number(legs[stops.length].duration)/60<=timeIn(ret);
}

const cityToken = value => String(value || '').toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function previousPlanContext(previous,p) {
  if (!previous || typeof previous!=='object' || !Array.isArray(previous.stops) || !p.destination) return null;
  const oldCity=cityToken(previous.destination),city=cityToken(p.destination);
  if (!oldCity || !(oldCity===city || oldCity.startsWith(`${city} `) || city.startsWith(`${oldCity} `))) return null;
  return { note:'Optional starting point from this browser. Current preferences always take priority; adapt or replace it as needed.',
    stops:previous.stops.slice(0,12).map(stop=>({name:String(stop?.name||'').slice(0,120),category:String(stop?.category||'').slice(0,60),description:String(stop?.description||'').slice(0,240)})).filter(stop=>stop.name) };
}

export async function createItinerary(p, previousItinerary = null) {
  if (!validPreferences(p)) return { status:400, body:{code:'invalid_preferences',message:'Please complete the required trip details and choose a same-day time window.'} };
  try {
    const origin=await geocode(p.start);
    if (!origin) return {status:422,body:{code:'origin_not_found',message:'OpenStreetMap could not verify the starting location.'}};
    const noDestination=!p.destination.trim();
    let center=origin, destination=p.destination.trim(), candidates=[];
    if (!noDestination) {
      center=await geocode(destination);
      if (!center) return {status:422,body:{code:'destination_not_found',message:'OpenStreetMap could not verify that destination.'}};
    }
    const radiusMeters=noDestination?Math.min(100000,Number(p.maxDistance)*1000):25000;
    candidates=await findNearby(center,radiusMeters);
    if (!candidates.length) return {status:503,body:{code:'no_verified_places',message:'No named OpenStreetMap places were found nearby. Enter a destination or try again.'}};

    const allResearch=await tavilyResearch(p,noDestination?`${p.start} day trip destinations`:destination);
    const weather=noDestination?{status:'unavailable',note:'Choose a destination for a forecast.'}:await weatherContext(destination,p.date);
    const sourceMenu=candidates.slice(0,35).map(x=>({name:x.name,category:x.category,lat:x.lat,lon:x.lon}));
    const prompt={preferences:p,destination:destination||null,verifiedOpenStreetMapPlaceCandidates:sourceMenu,weatherContext:weather,researchSources:allResearch,previousItinerary:previousPlanContext(previousItinerary,p)};
    const groqKey=process.env.GROQ_API_KEY;
    let generated=null;
    if (groqKey) {
      const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${groqKey}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),body:JSON.stringify({
        model:process.env.GROQ_MODEL||'openai/gpt-oss-20b',temperature:0.3,response_format:{type:'json_object'},
        messages:[{role:'system',content:'Plan a feasible one-day trip. Return valid JSON only with title, destination, stops, budget, tips. Stop shape: name, category, arrival (24h HH:MM), departure (24h HH:MM), description, match, duration (minutes), entryCostPerPerson (INR estimate), activityCostPerPerson (INR estimate). Budget keys: transportation, food, tickets, activities, parking, miscellaneous, each an INR estimate per person. Select stops only from verifiedOpenStreetMapPlaceCandidates using exact names. Never invent coordinates, opening hours, ticket prices, restaurants, or real-time facts. Leave costs estimates. Include meal/rest breaks as appropriate. Keep all stop times sequential between depart and return, leaving time for driving. If destination is null, recommend a reasonable nearby candidate and use its exact name as destination; return recommendation names and reasons in tips. Use weather context only if status is available; otherwise say forecast unavailable. Respect dietary needs, children, accessibility, max distance, budget basis, avoid/must-visit fields. If previousItinerary is present, treat it only as optional inspiration: current preferences, verified place candidates, and current schedule and budget always take priority. Make modest improvements where suitable and replace any outdated or unsuitable stops.'},{role:'user',content:JSON.stringify(prompt)}]})});
      if (response.ok) {
        try { generated=JSON.parse((await response.json()).choices?.[0]?.message?.content||'null'); } catch { generated=null; }
      }
    }

    const permitted=new Map(candidates.map(x=>[x.name.toLocaleLowerCase(),x]));
    let chosen=outputValid(generated)?generated.stops.map(s=>({raw:s,place:permitted.get(s.name.toLocaleLowerCase())})).filter(x=>x.place):[];
    if (!chosen.length) {
      const ranked=[...candidates].sort((a,b)=>haversine(origin,a)-haversine(origin,b));
      const count=Math.min(p.pace==='Relaxed'?3:4,ranked.length);
      chosen=ranked.slice(0,count).map((place,i)=>({place,raw:{name:place.name,category:place.category,arrival:'',departure:'',duration:Math.floor(75),description:`Mapped ${place.category.toLowerCase()} from OpenStreetMap. Confirm access before visiting.`,match:`Near ${destination||p.start}; coordinates verified by OpenStreetMap.`,entryCostPerPerson:0,activityCostPerPerson:0}}));
    }
    if (!destination) destination=chosen[0]?.place?.name || '';
    if (!destination) return {status:503,body:{code:'recommendation_unavailable',message:'No suitable nearby destination could be verified.'}};
    if (!center || noDestination) center=await geocode(destination) || chosen[0].place;
    const chosenStops=chosen.slice(0,7);
    const coords=[origin,...chosenStops.map(x=>x.place),origin];
    let route=null;
    if (p.transport.some(x=>x==='Personal car'||x==='Taxi or cab')) {
      const routeUrl=`https://router.project-osrm.org/route/v1/driving/${coords.map(x=>`${x.lon},${x.lat}`).join(';')}?overview=full&geometries=geojson&steps=false`;
      try { const r=await fetchJson(routeUrl,{},15000); if (r.code==='Ok'&&r.routes?.[0]?.geometry?.type==='LineString'&&Array.isArray(r.routes[0].geometry.coordinates)) route=r.routes[0]; } catch { route=null; }
    }
    if (outputValid(generated) && (!scheduleValid(generated.stops,p.depart,p.return) || (route && !routeScheduleValid(generated.stops,route.legs,p.depart,p.return))))
      return {status:422,body:{code:'infeasible_schedule',message:'The generated schedule does not fit the available day and verified driving times. Try regenerating or allow more time.'}};
    let stopRows=chosenStops.map((x,i)=>{
      const raw=x.raw, arrival=raw.arrival, departure=raw.departure;
      const hasSchedule=outputValid(generated)&&chosen.length===generated.stops.length&&scheduleValid(generated.stops,p.depart,p.return);
      return {id:`stop-${i+1}-${Date.now()}`,name:x.place.name,category:x.place.category,arrival:hasSchedule?arrival:'',departure:hasSchedule?departure:'',
        description:String(raw.description||'Mapped place; confirm access and details before visiting.'),match:String(raw.match||'Selected for your preferences from nearby mapped places.'),duration:Number(raw.duration)||75,
        distanceFromPreviousKm:null,travelMinutes:null,entryCostPerPerson:Number.isFinite(raw.entryCostPerPerson)?raw.entryCostPerPerson:null,activityCostPerPerson:Number.isFinite(raw.activityCostPerPerson)?raw.activityCostPerPerson:null,
        priceStatus:'unavailable',lat:x.place.lat,lon:x.place.lon,coordinatesVerified:true,routeVerified:false};
    });
    const moneyPerPerson=outputValid(generated)?generated.budget:{transportation:0,food:0,tickets:0,activities:0,parking:0,miscellaneous:0};
    const budget=Object.fromEntries(Object.entries(moneyPerPerson).map(([key,value])=>[key,Math.max(0,Math.round(value*p.adults+value*p.children*.65))]));
    const totalGroup=Object.values(budget).reduce((a,b)=>a+b,0), totalPerPerson=Math.ceil(totalGroup/(p.adults+p.children));
    const budgetLimit=p.budgetBasis==='group'?p.budget:p.budget*(p.adults+p.children);
    const recommendations=noDestination?chosenStops.slice(0,3).map((x,i)=>({name:x.place.name,reason:i===0?'Closest verified match to your selected interests.':`Nearby mapped option in ${x.place.category.toLowerCase()}.`,distanceKm:Math.round(haversine(origin,x.place)*10)/10,coordinatesVerified:true,lat:x.place.lat,lon:x.place.lon,sources:allResearch.slice(0,2)})):[];
    if (route) {
      const legDistances=route.legs||[];
      stopRows=stopRows.map((s,i)=>({...s,distanceFromPreviousKm:i===0?legDistances[0]?.distance/1000||null:legDistances[i]?.distance/1000||null,travelMinutes:i===0?legDistances[0]?.duration/60||null:legDistances[i]?.duration/60||null,routeVerified:true}));
    }
    const response={id:crypto.randomUUID(),title:String(generated?.title||`${destination}: a day at your pace`).slice(0,120),destination,start:p.start,date:p.date,travelers:p.adults+p.children,adults:p.adults,children:p.children,
      currency:'INR',budgetBasis:p.budgetBasis,budgetLimit,remainingBudget:budgetLimit-totalGroup,totalDistanceKm:route?route.distance/1000:null,routeVerified:Boolean(route),routeGeometry:route?.geometry.coordinates.map(([lon,lat])=>[lat,lon]),totalDurationHours:(new Date(`1970-01-01T${p.return}:00Z`)-new Date(`1970-01-01T${p.depart}:00Z`))/3600000,
      totalPerPerson,totalGroup,remainingBudgetPerPerson:Math.floor((budgetLimit-totalGroup)/(p.adults+p.children)),stops:stopRows,budget,
      recommendations,researchSources:allResearch,tips:Array.isArray(generated?.tips)?generated.tips.slice(0,8):['Place coordinates are verified through OpenStreetMap. Confirm opening hours and costs before travel.',weather.note,'Driving distances and duration are shown only when OSRM returned a complete route.'],
      source:groqKey&&outputValid(generated)?'ai':'demo',generatedAt:new Date().toISOString()};
    if (noDestination) response.destination=destination;
    return {status:200,body:response};
  } catch { return {status:502,body:{code:'planning_unavailable',message:'Trip planning services are temporarily unavailable. Please retry or enter a destination.'}}; }
}

export async function itineraryHandler(req,res) {
  if (req.method!=='POST') return json(res,405,{code:'method_not_allowed',message:'Use POST to generate an itinerary.'});
  const payload=req.body||{};
  const preferences=payload.preferences&&typeof payload.preferences==='object'?payload.preferences:payload;
  const result=await createItinerary(preferences,payload.previousItinerary||null);
  return json(res,result.status,result.body);
}
