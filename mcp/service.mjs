// mcp/service.mjs — start, install and uninstall the --http service.
//
//   --http --detach       start the service in the background (if the port is
//                         not already answering) and return at once.
//   --install-service     --detach now, and at every logon.
//   --uninstall-service   stop it and remove the logon entry.
//
// "At every logon" on Windows is a hidden launcher in the user's Startup
// folder: no admin rights, no console window, visible (and switchable) in
// Task Manager → Startup apps. Elsewhere this prints the one line to put in
// launchd/systemd/cron — those differ enough per machine that guessing is
// worse than saying.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { servicePaths, httpPort, portOwner } from './daemon-files.mjs';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lens-mcp.mjs');
const say = (m) => process.stdout.write(`${m}\n`);

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(j && j.app === 'claude-playback-lens' ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Start the service detached unless something already answers the port. */
export async function startDetached() {
  const port = httpPort();
  const S = servicePaths();
  const running = await health(port);
  if (running) {
    say(`Playback Lens service already running: http://127.0.0.1:${port}/mcp (pid ${running.pid}, ${running.version})`);
    return 0;
  }
  if (await portOpen(port)) {
    say(`port ${port} is ${await portOwner(port)}; set LENS_MCP_PORT to another port`);
    return 1;
  }
  fs.mkdirSync(S.dir, { recursive: true });
  const fd = fs.openSync(S.log, 'a');
  const child = spawn(process.execPath, [ENTRY, '--http'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const h = await health(port);
    if (h) {
      say(`Playback Lens service started: http://127.0.0.1:${port}/mcp (pid ${h.pid}; log ${S.log})`);
      return 0;
    }
  }
  say(`the service did not answer on port ${port} within 20s — see ${S.log}`);
  return 1;
}

function startupLauncher() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'claude-playback-lens.vbs');
}

export async function installService() {
  const code = await startDetached();
  if (process.platform !== 'win32') {
    say('Logon start is automatic only on Windows. Add this to your login items / systemd user unit / crontab @reboot:');
    say(`  "${process.execPath}" "${ENTRY}" --http --detach`);
    return code;
  }
  const q = (s) => s.replace(/"/g, '""');
  // Run from npx's cache (`npx -y claude-playback-lens-mcp --install-service`):
  // that path is evicted and replaced per version, so the launcher asks npx for
  // the newest release instead — one registry check per logon, which keeps the
  // auto-update the per-session `npx -y` used to give. Run from a global
  // install or a checkout: start exactly that install.
  const fromNpx = /[\\/]_npx[\\/]/.test(ENTRY);
  const cmd = fromNpx
    ? 'cmd /c npx -y claude-playback-lens-mcp@latest --http --detach'
    : `""${q(process.execPath)}"" ""${q(ENTRY)}"" --http --detach`;
  const vbs = [
    "' Claude Playback Lens: start the shared MCP service at logon, without a window.",
    "' Remove with: claude-playback-lens-mcp --uninstall-service (or delete this file).",
    `CreateObject("WScript.Shell").Run "${cmd}", 0, False`,
    '',
  ].join('\r\n');
  const file = startupLauncher();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, vbs);
  say(`logon launcher: ${file}`);
  return code;
}

export function uninstallService() {
  const file = startupLauncher();
  try { fs.unlinkSync(file); say(`removed ${file}`); } catch { say('no logon launcher was installed'); }
  const S = servicePaths();
  try {
    const { pid } = JSON.parse(fs.readFileSync(S.info, 'utf8'));
    process.kill(pid, 'SIGTERM');
    say(`stopped the service (pid ${pid})`);
  } catch { say('no running service recorded'); }
  return 0;
}
