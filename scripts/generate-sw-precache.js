#!/usr/bin/env node
// Regenerates the PRECACHE list and CACHE version in sw.js from the files
// actually shipped, so the two can't drift out of sync the way a hand-typed
// list does. Run after adding/removing/renaming a source file:
//
//   node scripts/generate-sw-precache.js
//
// CI re-runs this and fails the build if sw.js doesn't match (see
// .github/workflows/build.yml), so a forgotten update is caught rather than
// shipped as a stale offline cache.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const swPath = path.join(root, 'sw.js');

// Directories to precache in full, plus a few top-level files. Anything
// added under js/, css/, or vendor/ is picked up automatically.
const DIRS  = ['js', 'css', 'vendor'];
const FILES = ['index.html', 'manifest.json', 'icon.svg'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function toUrl(absPath) {
  return './' + path.relative(root, absPath).split(path.sep).join('/');
}

const precacheFiles = [
  ...FILES.map(f => path.join(root, f)),
  ...DIRS.flatMap(d => walk(path.join(root, d))),
].sort();

const precacheUrls = ['./', ...precacheFiles.map(toUrl)];

// Content hash of everything precached — the cache name changes whenever a
// precached file's contents change, so activate() evicts the old cache
// instead of relying on someone remembering to bump a version number.
const hash = crypto.createHash('sha256');
for (const f of precacheFiles) hash.update(fs.readFileSync(f));
const cacheVersion = hash.digest('hex').slice(0, 10);

const generated = `const CACHE = 'pdfsign-${cacheVersion}';
const PRECACHE = [
${precacheUrls.map(u => `  '${u}',`).join('\n')}
];`;

const current = fs.readFileSync(swPath, 'utf8');
const markerStart = '// ── AUTO-GENERATED: run scripts/generate-sw-precache.js to update ──';
const markerEnd   = '// ── END AUTO-GENERATED ──';
const blockRe = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);

const block = `${markerStart}\n${generated}\n${markerEnd}`;
const next = blockRe.test(current)
  ? current.replace(blockRe, block)
  : `${block}\n\n${current}`;

const checkOnly = process.argv.includes('--check');
const upToDate  = next === current;

if (upToDate) {
  console.log('sw.js is already up to date.');
} else if (checkOnly) {
  console.error('sw.js is out of date — run `node scripts/generate-sw-precache.js` and commit the result.');
  process.exit(1);
} else {
  fs.writeFileSync(swPath, next);
  console.log(`sw.js updated — ${precacheUrls.length} files precached, cache "pdfsign-${cacheVersion}".`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
