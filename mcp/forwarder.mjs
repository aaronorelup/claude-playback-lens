// mcp/forwarder.mjs — the per-session side of the shared daemon.
//
// Each Claude Code session's MCP server is this: it answers tools/list from
// the schemas alone and forwards every tools/call to the daemon, spawning the
// daemon when none is running. It never builds an index, so it costs a bare
// node process instead of a copy of the corpus.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { daemonPaths } from './daemon-files.mjs';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lens-mcp.mjs');
const SPAWN_WAIT_MS = 30000;

function request(info, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port: info.port,
      method,
      path: urlPath,
      headers: {
        'x-lens-token': info.token,
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function readInfo(P) {
  try { return JSON.parse(fs.readFileSync(P.info, 'utf8')); } catch { return null; }
}

async function ping(info) {
  if (!info || !info.port || !info.token) return false;
  try {
    const r = await request(info, 'GET', '/ping', undefined, 1500);
    return r.status === 200 && r.json && r.json.ok === true;
  } catch { return false; }
}

// The Claude Code session this forwarder serves. Claude Code sets
// CLAUDE_CODE_SESSION_ID in the environment of the processes it starts.
export function callerOf() {
  return { sessionId: process.env.CLAUDE_CODE_SESSION_ID || null };
}

export function createForwarder({ log = () => {} } = {}) {
  const P = daemonPaths();
  let info = null;

  function spawnDaemon() {
    fs.mkdirSync(P.dir, { recursive: true });
    const fd = fs.openSync(P.log, 'a');
    const child = spawn(process.execPath, [ENTRY, '--daemon', ...process.argv.slice(2)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    fs.closeSync(fd);
    log(`spawned lens daemon pid ${child.pid} (log: ${P.log})`);
  }

  async function ensure() {
    if (info && await ping(info)) return info;
    info = readInfo(P);
    if (await ping(info)) return info;
    spawnDaemon();
    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      info = readInfo(P);
      if (await ping(info)) return info;
    }
    info = null;
    throw new Error(`the lens daemon did not come up within ${SPAWN_WAIT_MS / 1000}s — see ${P.log}`);
  }

  async function invoke(name, args) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const inf = await ensure();
      try {
        const r = await request(inf, 'POST', '/call', { name, args, caller: callerOf() });
        if (r.status === 200 && r.json && r.json.result) return r.json.result;
        if (r.status === 503 || r.status === 403) { info = null; continue; } // closing / replaced — respawn
        throw new Error(`daemon answered HTTP ${r.status}`);
      } catch (e) {
        // A daemon that idled out between the ping and the call resets the
        // connection; one respawn-and-retry covers that race.
        if (attempt === 0 && e && /ECONNREFUSED|ECONNRESET|socket hang up/.test(`${e.code} ${e.message}`)) { info = null; continue; }
        throw e;
      }
    }
    throw new Error('the lens daemon closed twice in a row');
  }

  return { invoke, paths: P };
}
