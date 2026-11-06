import type { BudgetBreakdown, Itinerary, Preferences, SavedTrip, Stop } from './types';

export const interests = ['Nature & scenery','Hill stations','Adventure','Hiking','Beaches & lakes','Waterfalls','Wildlife','Religious places','Museums & art','Shopping','Local food','Photography','Entertainment','Hidden gems','Culture'];
export const initialPreferences: Preferences = {
  start: '', destination: '', date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), adults: 2, children: 0, travelers: 2, tripType: 'Couple',
  depart: '08:00', return: '19:00', pace: 'Balanced', budget: 5000, budgetBasis: 'group', budgetType: 'Moderate', spending: ['Transportation','Food','Activities and attractions'],
  interests: ['Nature & scenery','Local food','Photography'], transport: ['Personal car'], maxDistance: 100, multiMode: true,
  dietary: '', restaurantRecommendations: true, accessibility: '', childrenElderly: false, crowd: 'Less crowded', mustVisit: '', avoid: '',
  indoorOutdoor: 'Any', scenicRoutes: true, weatherFlexible: true, extra: ''
};
const id = () => globalThis.crypto?.randomUUID?.() || `trip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const toMinutes = (value: string) => { const [h,m] = value.split(':').map(Number); return h * 60 + m; };
const atTime = (n: number) => { const x = ((n % 1440) + 1440) % 1440; return `${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`; };

export function normalizePreferences(p: Preferences): Preferences {
  const adults = Math.max(0, Number(p.adults ?? p.travelers ?? 1));
  const children = Math.max(0, Number(p.children ?? 0));
  return { ...initialPreferences, ...p, adults, children, travelers: adults + children,
    budgetBasis: p.budgetBasis === 'person' ? 'person' : 'group', restaurantRecommendations: p.restaurantRecommendations ?? true,
    indoorOutdoor: p.indoorOutdoor || 'Any', scenicRoutes: p.scenicRoutes ?? false, weatherFlexible: p.weatherFlexible ?? false };
}

export function validatePreferences(input: Preferences): string | null {
  const p = normalizePreferences(input);
  if (!p.start.trim()) return 'Add your starting location to continue.';
  if (!p.destination.trim() && !p.start.trim()) return 'Add a starting location before asking for destination ideas.';
  if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return 'Choose a valid travel date.';
  if (p.adults < 1 || p.children < 0 || p.travelers > 30) return 'Enter at least one adult and no more than 30 travelers.';
  if (!p.interests.length) return 'Choose at least one interest.';
  if (!p.transport.length) return 'Choose at least one way to travel.';
  if (!Number.isFinite(p.budget) || p.budget <= 0) return 'Enter a budget greater than zero.';
  const depart = toMinutes(p.depart), end = toMinutes(p.return);
  if (!Number.isFinite(depart) || !Number.isFinite(end) || end - depart < 240) return 'Choose same-day times with at least four hours for your trip.';
  if (!Number.isFinite(p.maxDistance) || p.maxDistance <= 0) return 'Enter a valid maximum travel distance.';
  return null;
}

export function demoItinerary(input: Preferences): Itinerary {
  const p = normalizePreferences(input);
  if (!p.destination.trim()) throw new Error('Destination recommendations need a connection. Add a destination or try again online.');
  const available = toMinutes(p.return) - toMinutes(p.depart), count = available < 360 ? 2 : p.pace === 'Relaxed' ? 3 : 4;
  const templates = [
    ['Scenic pause','Take a gentle first pause and get oriented.','Viewpoint'],
    ['Explore at your pace','Leave time to explore a local point of interest.','Culture'],
    ['Lunch & local flavors','Take a proper meal break; verify the restaurant and opening hours before setting out.','Food & rest'],
    ['Fresh-air finish','End with an easy walk or another nearby activity.','Nature'],
  ];
  const block = Math.max(30, Math.floor((available - 25 - (count - 1) * 35) / count));
  let cursor = toMinutes(p.depart) + 20;
  const stops: Stop[] = templates.slice(0, count).map(([name,description,category], i) => {
    if (i) cursor += 35;
    const arrival = atTime(cursor); cursor += block;
    return { id: id(), name: `${name} near ${p.destination}`, category, arrival, departure: atTime(cursor), description,
      match: `A ${p.pace.toLowerCase()}-paced idea inspired by ${p.interests.slice(0,2).join(' and ')}.`, duration: block,
      distanceFromPreviousKm: null, travelMinutes: null, entryCostPerPerson: null, activityCostPerPerson: null, priceStatus: 'unavailable' };
  });
  const multiplier = p.travelers;
  const budget = { transportation: Math.round(450 * multiplier), food: Math.round((p.restaurantRecommendations ? 450 : 100) * multiplier), tickets: 0, activities: 0, parking: Math.round(100 * multiplier), miscellaneous: Math.round(150 * multiplier) };
  const totalGroup = Object.values(budget).reduce((sum,n)=>sum+n,0), totalPerPerson = Math.ceil(totalGroup / multiplier);
  const budgetLimit = p.budgetBasis === 'group' ? p.budget : p.budget * multiplier;
  return { id: id(), title: `${p.destination}: a day at your pace`, destination: p.destination, start: p.start, date: p.date,
    travelers: p.travelers, adults: p.adults, children: p.children, currency: 'INR', budgetBasis: p.budgetBasis, budgetLimit,
    remainingBudget: budgetLimit - totalGroup, totalDistanceKm: null, routeVerified: false, totalDurationHours: Math.round(available/60*10)/10,
    totalPerPerson, totalGroup, remainingBudgetPerPerson: Math.floor((budgetLimit-totalGroup)/multiplier), stops, budget,
    recommendations: [], researchSources: [], tips: ['Confirm opening hours, access, and prices with the venue before travelling.', 'Allow extra time for traffic and breaks.',
      p.weatherFlexible ? 'Check the forecast close to departure and swap outdoor plans if conditions change.' : 'Recheck local conditions before departure.'], source: 'demo', generatedAt: new Date().toISOString() };
}

export function validateItinerary(value: unknown): value is Itinerary {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<Itinerary>;
  return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.destination === 'string' && typeof x.start === 'string' &&
    typeof x.date === 'string' && Number.isFinite(x.travelers) && Number.isFinite(x.adults) && Number.isFinite(x.children) && x.currency === 'INR' &&
    (x.budgetBasis === 'group' || x.budgetBasis === 'person') && Number.isFinite(x.budgetLimit) && Number.isFinite(x.remainingBudget) &&
    (x.totalDistanceKm === null || Number.isFinite(x.totalDistanceKm)) && typeof x.routeVerified === 'boolean' && Number.isFinite(x.totalPerPerson) &&
    Number.isFinite(x.totalGroup) && Number.isFinite(x.totalDurationHours) && Array.isArray(x.stops) && x.stops.length > 0 &&
    x.stops.every(s => typeof s.name === 'string' && typeof s.arrival === 'string' && typeof s.departure === 'string' && typeof s.duration === 'number' &&
      (s.distanceFromPreviousKm === null || Number.isFinite(s.distanceFromPreviousKm)) && (s.travelMinutes === null || Number.isFinite(s.travelMinutes))) &&
    !!x.budget && ['transportation','food','tickets','activities','parking','miscellaneous'].every(k => Number.isFinite(x.budget![k as keyof BudgetBreakdown])) &&
    Array.isArray(x.tips) && Array.isArray(x.recommendations) && Array.isArray(x.researchSources) && (x.source === 'ai' || x.source === 'demo');
}

export type EvaluationCheckStatus = 'pass' | 'warning' | 'fail';
export interface ItineraryCheck { id: string; label: string; status: EvaluationCheckStatus; weight: number; detail: string; }
export interface ItineraryEvaluation { score: number; threshold: number; approved: boolean; checks: ItineraryCheck[]; }

export const ITINERARY_REVIEW_THRESHOLD = 80;
const normalizedText = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const minuteValue = (value: string) => { const match=/^(\d{2}):(\d{2})$/.exec(value||'');if(!match)return NaN;const h=Number(match[1]),m=Number(match[2]);return h<24&&m<60?h*60+m:NaN; };
const listTerms = (value: string) => value.split(/[,;\n]+/).map(x=>normalizedText(x)).filter(Boolean);

/** Deterministic pre-display check: it scores observable input/output constraints, not subjective trip quality. */
export function evaluateItinerary(plan: Itinerary, input: Preferences): ItineraryEvaluation {
  const p=normalizePreferences(input), checks:ItineraryCheck[]=[];
  const add=(id:string,label:string,weight:number,status:EvaluationCheckStatus,detail:string)=>checks.push({id,label,weight,status,detail});
  const destinationMatches=p.destination.trim()?normalizedText(plan.destination)===normalizedText(p.destination):Boolean(plan.destination.trim()&&plan.stops.some(s=>normalizedText(s.name)===normalizedText(plan.destination)));
  add('destination','Destination',10,destinationMatches?'pass':'fail',destinationMatches?'The plan uses the requested place or a named nearby recommendation.':`Expected “${p.destination || 'a nearby recommendation'}”; received “${plan.destination}”.`);
  const dateMatches=plan.date===p.date;
  add('date','Trip date',5,dateMatches?'pass':'fail',dateMatches?'The plan date matches your selected day.':`The plan date (${plan.date}) differs from your selected date (${p.date}).`);
  const travelersMatch=plan.adults===p.adults&&plan.children===p.children&&plan.travelers===p.adults+p.children;
  add('travelers','Traveler count',10,travelersMatch?'pass':'fail',travelersMatch?`${plan.adults} adults and ${plan.children} children are included.`:'The adult, child, or total traveler count does not match your input.');

  const start=minuteValue(p.depart),end=minuteValue(p.return);let cursor=start,scheduleOK=Number.isFinite(start)&&Number.isFinite(end)&&end>start&&plan.stops.length>0;
  for(const stop of plan.stops){const arrival=minuteValue(stop.arrival),departure=minuteValue(stop.departure);if(!Number.isFinite(arrival)||!Number.isFinite(departure)||arrival<cursor||departure<=arrival||departure>end){scheduleOK=false;break;}cursor=departure;}
  add('schedule','Same-day schedule',20,scheduleOK?'pass':'fail',scheduleOK?`All ${plan.stops.length} stops are ordered between ${p.depart} and ${p.return}.`:'At least one stop has missing, overlapping, reversed, or out-of-window times.');

  const budgetTotal=Object.values(plan.budget).reduce((sum,n)=>sum+(Number.isFinite(n)?n:0),0);
  const expectedLimit=p.budgetBasis==='person'?p.budget*p.travelers:p.budget;
  const budgetOK=Math.abs(budgetTotal-plan.totalGroup)<=1&&Math.abs(expectedLimit-plan.budgetLimit)<=1&&plan.totalGroup<=plan.budgetLimit+1&&Math.abs(Math.ceil(plan.totalGroup/Math.max(1,p.travelers))-plan.totalPerPerson)<=1;
  add('budget','Budget and totals',15,budgetOK?'pass':'fail',budgetOK?`Estimated total ${moneyForEvaluation(plan.totalGroup)} is within the ${p.budgetBasis==='person'?'per-person converted':'group'} budget.`:'The category totals, traveler basis, per-person total, or budget limit do not reconcile.');

  const planText=normalizedText(plan.stops.map(s=>`${s.name} ${s.category} ${s.description} ${s.match}`).join(' '));
  const must=listTerms(p.mustVisit),avoid=listTerms(p.avoid),missingMust=must.filter(term=>!planText.includes(term)),foundAvoid=avoid.filter(term=>planText.includes(term));
  const preferenceConstraintsOK=missingMust.length===0&&foundAvoid.length===0;
  const constraintDetail=[missingMust.length?`Missing must-visit: ${missingMust.join(', ')}.`:'',foundAvoid.length?`Avoided items appear: ${foundAvoid.join(', ')}.`:''].filter(Boolean).join(' ')||'Must-visit and avoid preferences are respected.';
  add('mustAvoid','Must-visit and avoid',10,preferenceConstraintsOK?'pass':'fail',constraintDetail);

  const interestTerms=p.interests.map(normalizedText).filter(Boolean),matched=interestTerms.filter(term=>planText.includes(term)||term.split(' ').some(token=>token.length>4&&planText.includes(token)));
  const interestsOK=interestTerms.length===0||matched.length>0;
  add('interests','Interest fit',20,interestsOK?'pass':'fail',interestTerms.length?`${matched.length} of ${interestTerms.length} selected interests are reflected in stop details.`:'No interests were selected.');

  const completeStops=plan.stops.every(s=>Boolean(s.name.trim()&&s.category.trim()&&s.description.trim()&&s.match.trim()));
  const mappedStops=plan.stops.filter(s=>s.coordinatesVerified).length;
  add('places','Stop details and place data',10,completeStops&&mappedStops===plan.stops.length?'pass':completeStops?'warning':'fail',!completeStops?'A stop is missing its name, category, description, or preference match.':`${mappedStops} of ${plan.stops.length} stops have verified map coordinates.`);

  const score=Math.round(checks.reduce((sum,c)=>sum+c.weight*(c.status==='pass'?1:c.status==='warning'?.5:0),0));
  const required=['destination','date','travelers','schedule','budget','mustAvoid'];
  const approved=score>=ITINERARY_REVIEW_THRESHOLD&&checks.filter(c=>required.includes(c.id)).every(c=>c.status==='pass');
  return {score,threshold:ITINERARY_REVIEW_THRESHOLD,approved,checks};
}

const moneyForEvaluation=(amount:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(amount);

const GENERATED_KEY = 'daytrip.generated.v1';
const cityKey = (city:string) => city.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

/** Auto-archive generated plans in this browser for future city reuse. */
export function readGeneratedPlans(): SavedTrip[] {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(GENERATED_KEY)||'[]');
    if(!Array.isArray(value))return [];
    return value.filter((x):x is SavedTrip=>!!x&&typeof x.id==='string'&&!!x.preferences&&!!x.itinerary&&validateItinerary(x.itinerary))
      .map(x=>({...x,preferences:normalizePreferences(x.preferences)}));
  } catch { return []; }
}

export function archiveGeneratedPlan(p:Preferences,itinerary:Itinerary):void {
  try {
    const entry:SavedTrip={id:itinerary.id,savedAt:new Date().toISOString(),preferences:normalizePreferences(p),itinerary};
    const entries=[entry,...readGeneratedPlans().filter(x=>x.id!==entry.id)].slice(0,40);
    localStorage.setItem(GENERATED_KEY,JSON.stringify(entries));
  } catch { /* Browser storage can be disabled or full; planning remains usable. */ }
}

export function removeGeneratedPlan(planId:string):SavedTrip[] {
  const entries=readGeneratedPlans().filter(entry=>entry.id!==planId);
  try { localStorage.setItem(GENERATED_KEY,JSON.stringify(entries)); } catch { /* Keep the current page usable if storage is unavailable. */ }
  return entries;
}

export function findPreviousItinerary(city:string):Itinerary|null {
  const key=cityKey(city);if(!key)return null;
  const match=readGeneratedPlans().find(entry=>{const saved=cityKey(entry.itinerary.destination);return saved===key||saved.startsWith(`${key} `)||key.startsWith(`${saved} `);});
  return match?.itinerary||null;
}

function adaptArchivedItinerary(previous:Itinerary,p:Preferences):Itinerary {
  const fresh=demoItinerary(p),available=toMinutes(p.return)-toMinutes(p.depart),gap=25;
  const slot=Math.max(30,Math.floor((available-gap*(previous.stops.length-1)-20)/previous.stops.length));let cursor=toMinutes(p.depart)+20;
  const stops=previous.stops.map((stop,index)=>{if(index)cursor+=gap;const arrival=atTime(cursor);cursor+=slot;return {...stop,id:id(),arrival,departure:atTime(cursor),duration:slot,distanceFromPreviousKm:null,travelMinutes:null,entryCostPerPerson:null,activityCostPerPerson:null,priceStatus:'unavailable' as const,lat:undefined,lon:undefined,coordinatesVerified:false,routeVerified:false};});
  return {...previous,id:id(),title:`${p.destination}: a refreshed day at your pace`,destination:p.destination,start:p.start,date:p.date,travelers:p.travelers,adults:p.adults,children:p.children,budgetBasis:fresh.budgetBasis,budgetLimit:fresh.budgetLimit,remainingBudget:fresh.remainingBudget,remainingBudgetPerPerson:fresh.remainingBudgetPerPerson,totalDistanceKm:null,routeVerified:false,routeGeometry:undefined,totalDurationHours:fresh.totalDurationHours,totalPerPerson:fresh.totalPerPerson,totalGroup:fresh.totalGroup,budget:fresh.budget,stops,tips:[...fresh.tips,'Started from your earlier saved plan for this city; timings and budget were refreshed for these preferences.'],source:'demo',generatedAt:new Date().toISOString()};
}

export async function generateItinerary(input: Preferences, previous:Itinerary|null=null): Promise<Itinerary> {
  const p = normalizePreferences(input);
  const response = await fetch('/api/itinerary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({preferences:p,previousItinerary:previous}) }).catch(() => null);
  if (response?.ok) {
    const data: unknown = await response.json().catch(() => null);
    if (validateItinerary(data)) return previous&&data.source==='demo'&&!(data as Itinerary&{archivePersisted?:boolean}).archivePersisted&&cityKey(previous.destination)===cityKey(p.destination)?adaptArchivedItinerary(previous,p):data;
  }
  if (!p.destination.trim()) throw new Error('Nearby destination recommendations are unavailable. Check your connection and try again, or enter a destination.');
  return previous&&cityKey(previous.destination)===cityKey(p.destination)?adaptArchivedItinerary(previous,p):demoItinerary(p);
}

const KEY = 'daytrip.saved.v1';
export function readTrips(): SavedTrip[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((x): x is SavedTrip => !!x && typeof x.id === 'string' && !!x.preferences && !!x.itinerary)
      .map(x => ({ ...x, preferences: normalizePreferences(x.preferences) }));
  } catch { return []; }
}
export function saveTrip(p: Preferences, itinerary: Itinerary): SavedTrip[] {
  const trip = { id: itinerary.id, savedAt: new Date().toISOString(), preferences: normalizePreferences(p), itinerary };
  const trips = [trip, ...readTrips().filter(x => x.id !== trip.id)]; localStorage.setItem(KEY, JSON.stringify(trips)); return trips;
}
export function removeTrip(tripId: string) { const trips = readTrips().filter(x => x.id !== tripId); localStorage.setItem(KEY, JSON.stringify(trips)); return trips; }
