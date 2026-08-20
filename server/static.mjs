// server/static.mjs — static file serving for web/ + /shared/pricing.mjs.
// Correct MIME, no directory listing, no path escapes (group D; SPEC §9).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function insideRoot(root, abs) {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  const rl = process.platform === 'win32' ? r.toLowerCase() : r;
  const al = process.platform === 'win32' ? a.toLowerCase() : a;
  return al === rl || al.startsWith(rl + path.sep);
}

async function serveFile(res, absPath) {
  let st;
  try { st = await fsp.stat(absPath); } catch { return false; }
  if (!st.isFile()) return false; // directories are never listed
  res.writeHead(200, {
    'Content-Type': mimeFor(absPath),
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  await new Promise((resolve) => {
    const s = fs.createReadStream(absPath);
    s.pipe(res);
    s.on('error', () => { try { res.end(); } catch { /* ignore */ } resolve(); });
    s.on('end', resolve);
  });
  return true;
}

// The lens glyph — the SAME icon web/index.html inlines as a data: URI, so
// the tab icon and the /favicon.ico fallback agree. Served inline (no file,
// no dependency) for the browsers/tools that request /favicon.ico regardless
// of the <link> tag, so those requests never 404.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
  + '<circle cx="8" cy="8" r="6" fill="none" stroke="#b4531f" stroke-width="2"/>'
  + '<line x1="12" y1="12" x2="15" y2="15" stroke="#b4531f" stroke-width="2"/></svg>';

function serveFavicon(res) {
  const buf = Buffer.from(FAVICON_SVG, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
  return true;
}

// Returns an async (req, res, pathname) => boolean fallback for http.mjs.
export function createStaticHandler({ webDir, sharedDir }) {
  return async function staticFallback(_req, res, pathname) {
    // never trust the URL path: decode, forbid backslashes / .. / drive colons
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return false; }
    if (decoded.includes('\\') || decoded.includes('..') || decoded.includes(':')) return false;

    if (decoded === '/' || decoded === '/index.html') {
      return serveFile(res, path.join(webDir, 'index.html'));
    }
    if (decoded === '/favicon.ico' || decoded === '/favicon.svg') {
      // a real file in web/ wins if one ever lands; otherwise the inline glyph
      if (await serveFile(res, path.join(webDir, decoded.slice(1)))) return true;
      return serveFavicon(res);
    }
    if (decoded.startsWith('/shared/')) {
      const rel = decoded.slice('/shared/'.length);
      const abs = path.join(sharedDir, rel);
      if (!insideRoot(sharedDir, abs)) return false;
      return serveFile(res, abs);
    }
    const abs = path.join(webDir, decoded.replace(/^\/+/, ''));
    if (!insideRoot(webDir, abs)) return false;
    return serveFile(res, abs);
  };
}
