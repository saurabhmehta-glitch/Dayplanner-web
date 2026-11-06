import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createItinerary, placesHandler, routeHandler } from '../server/planning.js';

const originalFetch=globalThis.fetch;
const savedEnv={GROQ_API_KEY:process.env.GROQ_API_KEY,TAVILY_API_KEY:process.env.TAVILY_API_KEY,OPENWEATHER_API_KEY:process.env.OPENWEATHER_API_KEY};
const base={start:'Bengaluru',destination:'Mysuru',date:'2026-11-08',adults:2,children:0,travelers:2,tripType:'Couple',depart:'08:00',return:'19:00',pace:'Balanced',budget:2000,budgetBasis:'group',budgetType:'Moderate',spending:['Transportation','Food'],interests:['Nature & scenery','Local food'],transport:['Personal car'],maxDistance:100,multiMode:true,dietary:'',restaurantRecommendations:true,accessibility:'',childrenElderly:false,crowd:'Less crowded',mustVisit:'',avoid:'',indoorOutdoor:'Any',scenicRoutes:true,weatherFlexible:true,extra:''};
let generated, promptSeen, failGroq=false, failPlaces=false, failTavily=false, badWeather=false, routeDuration=600;
const ok=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function plan(stops=[
  {name:'Brindavan Gardens',category:'Nature',arrival:'09:00',departure:'10:30',duration:90,description:'Garden visit',match:'Scenic choice',entryCostPerPerson:0,activityCostPerPerson:0},
  {name:'Mysuru Palace',category:'Attraction',arrival:'11:00',departure:'12:30',duration:90,description:'Cultural visit',match:'History choice',entryCostPerPerson:100,activityCostPerPerson:0}
]){return {title:'A Mysuru day',destination:'Mysuru',stops,budget:{transportation:500,food:450,tickets:100,activities:100,parking:50,miscellaneous:50},tips:['Check venue access']};}
function forecastList(date){const dt=Date.parse(`${date}T12:00:00Z`)/1000;return [{dt,main:{temp:22,temp_min:19,temp_max:25},pop:badWeather?.8:.1,weather:[{main:badWeather?'Rain':'Clear',description:badWeather?'heavy rain':'clear sky'}]}];}

beforeEach(()=>{
  process.env.GROQ_API_KEY='mock-groq';process.env.TAVILY_API_KEY='mock-tavily';delete process.env.OPENWEATHER_API_KEY;
  generated=plan();promptSeen='';failGroq=false;failPlaces=false;failTavily=false;badWeather=false;routeDuration=600;
  globalThis.fetch=async(input,options={})=>{
    const u=new URL(input);
    if(u.hostname==='nominatim.openstreetmap.org'){
      const q=u.searchParams.get('q');const coords=q==='Bengaluru'?['12.9716','77.5946']:['12.2958','76.6394'];
      return ok([{lat:coords[0],lon:coords[1],display_name:q}]);
    }
    if(u.hostname==='overpass-api.de'){
      if(failPlaces)return ok({error:'offline'},503);
      return ok({elements:[{type:'node',id:1,lat:12.4,lon:76.7,tags:{name:'Brindavan Gardens',tourism:'attraction'}},{type:'node',id:2,lat:12.31,lon:76.65,tags:{name:'Mysuru Palace',historic:'palace'}}]});
    }
    if(u.hostname==='api.tavily.com')return failTavily?ok({},503):ok({results:[{title:'Mysuru visitor guide',url:'https://example.test/mysuru',content:'Visitor information'}]});
    if(u.hostname==='api.groq.com'){
      const body=JSON.parse(options.body);promptSeen=body.messages[1].content;
      if(failGroq)return ok({error:'mock failure'},503);
      return ok({choices:[{message:{content:JSON.stringify(generated)}}]});
    }
    if(u.hostname==='router.project-osrm.org'){
      const coords=u.pathname.split('/').at(-1).split(';');const count=coords.length-1;
      return ok({code:'Ok',routes:[{distance:50000,duration:routeDuration*(count),legs:Array.from({length:count},()=>({distance:10000,duration:routeDuration})),geometry:{type:'LineString',coordinates:[[77.59,12.97],[76.7,12.4],[76.65,12.31],[77.59,12.97]]}}]});
    }
    if(u.hostname==='api.openweathermap.org'){
      if(u.pathname==='/geo/1.0/direct')return ok([{lat:12.29,lon:76.63,name:'Mysuru',country:'IN'}]);
      if(u.pathname==='/data/2.5/forecast')return ok({city:{timezone:0},list:forecastList(base.date)});
      return ok({},404);
    }
    throw new Error(`Unexpected mock URL ${u.hostname}${u.pathname}`);
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;for(const key of Object.keys(savedEnv)){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}});

test('normal Bengaluru to Mysuru trip is structured, feasible, and sourced',async()=>{
  const r=await createItinerary(base);assert.equal(r.status,200);assert.equal(r.body.source,'ai');assert.equal(r.body.destination,'Mysuru');assert.equal(r.body.stops.length,2);assert.equal(r.body.currency,'INR');assert.equal(r.body.researchSources[0].url,'https://example.test/mysuru');
});
test('tight total budget remains transparent and reports the overage',async()=>{
  const r=await createItinerary({...base,budget:500});assert.equal(r.status,200);assert.equal(r.body.remainingBudget,500-r.body.totalGroup);assert.ok(r.body.remainingBudget<0);assert.equal(r.body.budgetBasis,'group');
});
test('weather context flags heavy rain for the AI instead of hiding the forecast',async()=>{
  process.env.OPENWEATHER_API_KEY='mock-weather';badWeather=true;await createItinerary(base);assert.match(promptSeen,/heavy rain|Rain/i);
});
test('blank destination returns real nearby OSM recommendations',async()=>{
  generated=plan([{...plan().stops[0],name:'Brindavan Gardens'}]);const r=await createItinerary({...base,destination:''});assert.equal(r.status,200);assert.equal(r.body.destination,'Brindavan Gardens');assert.ok(r.body.recommendations.length);assert.ok(r.body.recommendations[0].coordinatesVerified);
});
test('six-hour window succeeds only when schedule fits',async()=>{
  generated=plan([{...plan().stops[0],arrival:'07:00',departure:'09:00',duration:120}]);routeDuration=300;
  const r=await createItinerary({...base,depart:'06:00',return:'12:00'});assert.equal(r.status,200);assert.equal(r.body.stops.length,1);
});
test('family input preserves adult and child totals',async()=>{
  const r=await createItinerary({...base,adults:2,children:2,travelers:4,tripType:'Family'});assert.equal(r.status,200);assert.equal(r.body.travelers,4);assert.equal(r.body.adults,2);assert.equal(r.body.children,2);
});
test('adventure interests and accessibility needs reach Groq context',async()=>{
  const r=await createItinerary({...base,interests:['Adventure','Waterfalls','Hiking'],accessibility:'step-free paths'});assert.equal(r.status,200);assert.match(promptSeen,/Waterfalls/);assert.match(promptSeen,/step-free paths/);
});
test('Groq and Tavily failures degrade without exposing credentials',async()=>{
  failGroq=true;failTavily=true;
  const r=await createItinerary(base);assert.equal(r.status,200);assert.equal(r.body.source,'demo');assert.doesNotMatch(JSON.stringify(r.body),/mock-groq|mock-tavily/);
});
test('no credential demo can still recommend verified nearby places',async()=>{
  delete process.env.GROQ_API_KEY;delete process.env.TAVILY_API_KEY;
  const r=await createItinerary({...base,destination:''});assert.equal(r.status,200);assert.equal(r.body.source,'demo');assert.ok(r.body.recommendations.length);assert.ok(r.body.stops.every(s=>s.priceStatus==='unavailable'));
});
test('only OpenStreetMap coordinates and OSRM routes are marked verified',async()=>{
  const r=await createItinerary(base);assert.equal(r.body.routeVerified,true);assert.equal(r.body.totalDistanceKm,50);assert.ok(r.body.routeGeometry.length);assert.ok(r.body.stops.every(s=>s.coordinatesVerified&&s.routeVerified));
});
test('invalid schedule is rejected rather than displayed as feasible',async()=>{
  generated=plan([{...plan().stops[0],arrival:'18:00',departure:'19:30',duration:90}]);const r=await createItinerary(base);assert.equal(r.status,422);assert.equal(r.body.code,'infeasible_schedule');
});
test('places provider failure returns a useful sanitized response',async()=>{
  failPlaces=true;const r=await createItinerary(base);assert.equal(r.status,502);assert.doesNotMatch(JSON.stringify(r.body),/mock-groq|mock-tavily/);
});
test('map geocoding remains usable when OpenStreetMap POI lookup fails',async()=>{
  failPlaces=true;const res={statusCode:200,status(code){this.statusCode=code;return this;},setHeader(){return this;},json(body){this.body=body;return this;}};
  await placesHandler({method:'GET',query:{destination:'Mysuru'}},res);assert.equal(res.statusCode,200);assert.equal(res.body.center.lat,12.2958);assert.deepEqual(res.body.places,[]);assert.equal(res.body.placesStatus,'unavailable');
});
test('route endpoint validates profiles and returns actual route response only',async()=>{
  const res={statusCode:200,status(code){this.statusCode=code;return this;},setHeader(){return this;},json(body){this.body=body;return this;}};
  await routeHandler({method:'POST',body:{profile:'walking',points:[{lat:1,lon:1},{lat:2,lon:2}]}},res);assert.equal(res.statusCode,422);
  const driving={...res,statusCode:200};await routeHandler({method:'POST',body:{profile:'driving',points:[{lat:12,lon:77},{lat:13,lon:76}]}},driving);assert.equal(driving.statusCode,200);assert.equal(driving.body.source,'OSRM');
});

