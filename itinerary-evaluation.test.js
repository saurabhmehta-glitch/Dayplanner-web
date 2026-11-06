import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveGeneratedPlan, demoItinerary, evaluateItinerary, findPreviousItinerary, generateItinerary, initialPreferences, ITINERARY_REVIEW_THRESHOLD } from '../src/core.ts';

const preferences = { ...initialPreferences, start: 'Bengaluru', destination: 'Mysuru', budget: 5000 };

test('a compliant demo plan passes the input-fit threshold with itemized checks', () => {
  const result = evaluateItinerary(demoItinerary(preferences), preferences);
  assert.equal(ITINERARY_REVIEW_THRESHOLD, 80);
  assert.equal(result.approved, true);
  assert.ok(result.score >= result.threshold);
  assert.deepEqual(result.checks.map(check => check.id), ['destination','date','travelers','schedule','budget','mustAvoid','interests','places']);
});

test('the 80% cutoff rejects weak preference fit even when required checks pass', () => {
  const weakPreferences={...preferences,interests:['Astronomy']};
  const source=demoItinerary(preferences);
  const weakPlan={...source,stops:source.stops.map(stop=>({...stop,category:'',description:'',match:''}))};
  const result=evaluateItinerary(weakPlan,weakPreferences);
  assert.equal(result.score,70);
  assert.equal(result.checks.filter(check=>['destination','date','travelers','schedule','budget','mustAvoid'].includes(check.id)).every(check=>check.status==='pass'),true);
  assert.equal(result.approved,false);
  assert.equal(result.threshold,80);
});

test('generated itineraries auto-archive and can be found again by city', () => {
  const storage=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
  const plan=demoItinerary(preferences);archiveGeneratedPlan(preferences,plan);
  assert.equal(findPreviousItinerary('mysuru')?.id,plan.id);
  assert.equal(findPreviousItinerary('Ooty'),null);
  delete globalThis.localStorage;
});

test('offline generation refreshes an archived city plan for the new preferences', async () => {
  const previous=demoItinerary(preferences),fetchBefore=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('offline')};
  try {
    const nextPrefs={...preferences,date:'2030-01-02',adults:3,travelers:3,depart:'09:00',return:'18:00'};
    const refreshed=await generateItinerary(nextPrefs,previous);
    assert.equal(refreshed.date,nextPrefs.date);
    assert.equal(refreshed.adults,3);
    assert.equal(refreshed.stops[0].name,previous.stops[0].name);
    assert.equal(refreshed.routeVerified,false);
    assert.equal(evaluateItinerary(refreshed,nextPrefs).approved,true);
  } finally { globalThis.fetch=fetchBefore; }
});

test('a plan with a different destination, traveler count, or date is held', () => {
  const plan = demoItinerary(preferences);
  const evaluation = evaluateItinerary({ ...plan, destination: 'Ooty', date: '2030-01-01', travelers: 1 }, preferences);
  assert.equal(evaluation.approved, false);
  for (const id of ['destination','date','travelers']) assert.equal(evaluation.checks.find(check => check.id === id).status, 'fail');
});

test('overlapping or out-of-window stops fail the schedule check', () => {
  const plan = demoItinerary(preferences);
  const result = evaluateItinerary({ ...plan, stops: plan.stops.map((stop, index) => index === 1 ? { ...stop, arrival: plan.stops[0].arrival } : stop) }, preferences);
  assert.equal(result.approved, false);
  assert.equal(result.checks.find(check => check.id === 'schedule').status, 'fail');
});

test('budget math and avoided-place violations hold the plan', () => {
  const p = { ...preferences, budget: 1000, avoid: 'Lunch' };
  const plan = demoItinerary({ ...preferences, budget: 1000 });
  const result = evaluateItinerary(plan, p);
  assert.equal(result.approved, false);
  assert.equal(result.checks.find(check => check.id === 'budget').status, 'fail');
  assert.equal(result.checks.find(check => check.id === 'mustAvoid').status, 'fail');
});
