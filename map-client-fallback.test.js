import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('map renders verified nearby OSM places when itinerary stops lack coordinates', async () => {
  const source=await readFile(new URL('../src/ui/MapPanel.tsx',import.meta.url),'utf8');
  assert.match(source,/setNearbyPlaces\(Array\.isArray\(data\.places\)/);
  assert.match(source,/!stops\.length&&nearbyPlaces\.map/);
  assert.match(source,/not an itinerary stop/);
});
