#!/usr/bin/env node
// Copies static frontend assets into dist/ for Tauri bundling.
// No build step needed — pdfsign is a pure static web app.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const include = ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'icon.svg', 'vendor'];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

for (const item of include) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) {
    copyRecursive(src, path.join(dist, item));
    console.log(`copied ${item}`);
  } else {
    console.warn(`warning: ${item} not found, skipping`);
  }
}

console.log('frontend ready in dist/');
