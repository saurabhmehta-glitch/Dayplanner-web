import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import weatherHandler from '../api/weather.js';
import { itineraryHandler, placesHandler, routeHandler } from './planning.js';

const app=express();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const isDev=process.argv.includes('--dev');
app.use(express.json({limit:'100kb'}));
app.post('/api/itinerary',itineraryHandler);
app.get('/api/weather',weatherHandler);
app.get('/api/places',placesHandler);
app.post('/api/route',routeHandler);
if (isDev) {
  const {createServer}=await import('vite');
  const vite=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{middlewareMode:true},appType:'spa'});
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root,'dist')));
  app.get('*splat',(_req,res)=>res.sendFile(path.join(root,'dist','index.html')));
}
const port=Number(isDev?process.env.VITE_PORT||5173:process.env.PORT||8787);
app.listen(port,()=>console.log(`Daytrip is available at http://localhost:${port}`));
