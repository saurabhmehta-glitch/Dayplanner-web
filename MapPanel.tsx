import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { ExternalLink, RotateCcw } from 'lucide-react';
import type { Itinerary, Place } from '../types';

const pin=L.divIcon({className:'daytrip-map-pin',html:'<span></span>',iconSize:[20,20],iconAnchor:[10,10]});
type Point={lat:number;lon:number};
function Bounds({points}:{points:Point[]}){const map=useMap();useEffect(()=>{if(points.length>1)map.fitBounds(points.map(p=>[p.lat,p.lon]),{padding:[35,35],maxZoom:12});else if(points[0])map.setView([points[0].lat,points[0].lon],11);},[map,points]);return null;}

export default function MapPanel({itinerary}:{itinerary:Itinerary}){
  const [center,setCenter]=useState<Point|null>(null),[nearbyPlaces,setNearbyPlaces]=useState<Place[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [tilesFailed,setTilesFailed]=useState(false),[tileAttempt,setTileAttempt]=useState(0);
  useEffect(()=>{let active=true;const controller=new AbortController();setLoading(true);setError('');setCenter(null);setNearbyPlaces([]);setTilesFailed(false);
    fetch(`/api/places?destination=${encodeURIComponent(itinerary.destination)}`,{signal:controller.signal})
      .then(async r=>{const data=await r.json().catch(()=>null);if(!r.ok)throw new Error(data?.message||'Could not locate this destination.');if(!Number.isFinite(data?.center?.lat)||!Number.isFinite(data?.center?.lon))throw new Error('No verified map center was returned.');if(active){setCenter({lat:data.center.lat,lon:data.center.lon});setNearbyPlaces(Array.isArray(data.places)?data.places.filter((p:Place)=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180):[]);}})
      .catch(e=>{if(active&&!controller.signal.aborted)setError(e instanceof Error?e.message:'Map lookup is unavailable.');})
      .finally(()=>{if(active)setLoading(false);});
    const timeout=window.setTimeout(()=>controller.abort(),15000);
    return()=>{active=false;controller.abort();window.clearTimeout(timeout);};
  },[itinerary.destination,retry]);
  const stops=itinerary.stops.filter(s=>s.coordinatesVerified&&Number.isFinite(s.lat)&&Number.isFinite(s.lon));
  const stopPoints=useMemo(()=>stops.map(s=>({lat:s.lat!,lon:s.lon!})),[itinerary.stops]);
  const mapCenter=center||stopPoints[0]||null;
  const nearbyPoints=useMemo(()=>nearbyPlaces.map(p=>({lat:p.lat,lon:p.lon})),[nearbyPlaces]);
  const points=useMemo(()=>[...(center?[center]:[]),...stopPoints,...(stopPoints.length?[]:nearbyPoints)], [center,stopPoints,nearbyPoints]);
  const route=itinerary.routeGeometry||[];
  return <div className="map-shell">
    {mapCenter?<><MapContainer center={[mapCenter.lat,mapCenter.lon]} zoom={11} scrollWheelZoom={false} className="leaflet-map">
      <TileLayer key={tileAttempt} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" eventHandlers={{tileerror:()=>setTilesFailed(true)}}/>
      {center&&<Marker position={[center.lat,center.lon]} icon={pin}><Popup>{itinerary.destination} · approximate destination center</Popup></Marker>}
      {stops.map((s,i)=><Marker key={s.id} position={[s.lat!,s.lon!]} icon={pin}><Popup>{i+1}. {s.name}<br/>{s.arrival||'Time unavailable'}</Popup></Marker>)}
      {!stops.length&&nearbyPlaces.map(place=><Marker key={`${place.name}-${place.lat}-${place.lon}`} position={[place.lat,place.lon]} icon={pin}><Popup>{place.name}<br/>Nearby OpenStreetMap place · not an itinerary stop</Popup></Marker>)}
      {route.length>1&&<Polyline positions={route} pathOptions={{color:'#c4a675',weight:4,opacity:.92}}/>}<Bounds points={points}/>
    </MapContainer>{tilesFailed&&<div className="map-tile-warning" role="status">Map tiles are temporarily unavailable. Verified pins remain available.<button onClick={()=>{setTilesFailed(false);setTileAttempt(n=>n+1)}}><RotateCcw size={12}/> Retry map</button></div>}</>:<div className="map-placeholder map-fallback"><div className="map-grid"/><div className="map-center"><span className={loading?'spinner':'map-pin'}><span/></span><b>{loading?'Locating your map…':'Map tiles are unavailable'}</b><small>{loading?'Looking up a verified destination center':error||'Open the destination in OpenStreetMap or retry the lookup.'}</small>{!loading&&<div className="map-fallback-actions"><button onClick={()=>setRetry(n=>n+1)}><RotateCcw size={13}/> Retry map</button><a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(itinerary.destination)}`} target="_blank" rel="noreferrer">OpenStreetMap <ExternalLink size={12}/></a></div>}</div></div>}
    <div className="map-caption"><span className="status-dot"/>{itinerary.routeVerified?'Verified OSRM driving route':center&&stops.length?'Verified mapped stops · road route unavailable':center&&nearbyPlaces.length?'Nearby verified places · not itinerary stops':center?'Approximate destination area':'Verified stop pins'}<span>© OpenStreetMap</span></div>
  </div>;
}
