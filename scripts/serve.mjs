// Minimal static dev server (stdlib only). ES modules do not load from file://.
// Usage: node scripts/serve.mjs [port]   (default 8080, bound to 127.0.0.1; HOST=... to change)
import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
// loopback only by default; set HOST=0.0.0.0 deliberately to share on a network
const host = process.env.HOST || '127.0.0.1';
const realRoot = await realpath(root);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }
    if (rel.includes('\0')) { res.writeHead(400).end('Bad request'); return; }
    // never serve dotfiles or dot-directories (.git, .claude, .env ...)
    if (rel.split('/').some((seg) => seg.startsWith('.'))) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden'); return; }
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    // no directory traversal: resolved path must stay inside root
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
    let st = await stat(file).catch(() => null);
    if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await stat(file).catch(() => null); }
    if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    // symlinks must not lead outside the repository
    const real = await realpath(file);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error');
  }
});

server.listen(port, host, () => console.log(`Serving ${root} at http://${host}:${port}`));
