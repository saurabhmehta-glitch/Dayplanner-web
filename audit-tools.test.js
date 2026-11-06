import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('critic review is on the itinerary page; local audit API remains private', async () => {
  const [server, ignore, app] = await Promise.all([read('start-static.ps1'), read('.gitignore'), read('src/ui/App.tsx')]);
  assert.match(server, /TcpListener.*IPAddress\]::Loopback/s);
  assert.match(await read('audit-tools.ps1'), /request\.Url\.Host -notin @\('localhost','127\.0\.0\.1'/);
  assert.match(server, /Get-AuditResponse \$request/);
  assert.doesNotMatch(server, /Join-Path \$PSScriptRoot 'audit-dashboard\.html'/);
  assert.doesNotMatch(server, /audit-dashboard\.html/);
  assert.doesNotMatch(app, /audit-dashboard|Critic ↗/);
  assert.match(app, /PlanReview evaluation=\{evaluation\}/);
  assert.match(ignore, /audit-reports\//);
});

test('audit collector excludes local secrets/generated data and redacts credential-like strings', async () => {
  const source = await read('audit-tools.ps1');
  assert.match(source, /\$baseName -eq '\.env'/);
  assert.match(source, /'\.env\.example'/);
  assert.match(source, /'node_modules','dist','audit-reports'/);
  assert.match(source, /\$raw\.Replace\(\$apiKey, '\[REDACTED\]'\)/);
  assert.match(source, /gsk_\[A-Za-z0-9_-/);
  assert.match(source, /WriteAllText\(\$reportPath/);
});

test('audit scoring uses the seven fixed weights, zero credit for unverified categories, and separate coverage', async () => {
  const source = await read('audit-tools.ps1');
  for (const weight of [15, 15, 25, 15, 15, 10, 5]) assert.ok(source.includes(`weight=${weight}`));
  assert.match(source, /\$weighted \+= \(\$score\*\$category\.weight\/100\)/);
  assert.match(source, /\$coverage=\[Math\]::Round\(100\*\$verifiedChecks\/\$applicableChecks,2\)/);
  assert.match(source, /\$reports\.Count -ge 10/);
  assert.match(source, /AUD-\x27\+\(\(\[BitConverter\]::ToString\(\$digest\)/);
});

