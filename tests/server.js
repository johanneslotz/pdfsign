// Minimal static file server for Playwright tests
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3100;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.pdf':  'application/pdf',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
};

http.createServer((req, res) => {
  const urlPath  = req.url.split('?')[0];
  const filePath = urlPath === '/'
    ? path.join(ROOT, 'index.html')
    : path.join(ROOT, urlPath);

  // Guard against path traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Test server: http://localhost:${PORT}`));
