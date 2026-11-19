import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

/**
 * Serves the ShimentoX LMS (a separate Python server) under /lms on this server's port, so the whole application
 * runs on one port. The Python server listens on loopback only (LMS_INTERNAL_PORT); this proxy strips the /lms
 * prefix before forwarding, and the LMS adds it back to the addresses it hands the browser (LMS_BASE_PATH).
 */
export const LMS_MOUNT = '/lms';

const lmsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lms');
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

let child: ChildProcess | undefined;

/** Express middleware for /lms and /lms/*. Must be registered before any body parser so request bodies stream through. */
export function lmsProxy(req: Request, res: Response, next: NextFunction): void {
  const url = req.originalUrl;
  if (url !== LMS_MOUNT && !url.startsWith(`${LMS_MOUNT}/`) && !url.startsWith(`${LMS_MOUNT}?`)) return next();

  // The LMS frontend uses relative addresses, so its page must be loaded from /lms/ (with the slash).
  if (url === LMS_MOUNT || url.startsWith(`${LMS_MOUNT}?`)) {
    res.redirect(301, `${LMS_MOUNT}/${url.slice(LMS_MOUNT.length)}`);
    return;
  }

  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  }
  // Host is kept as the browser sent it, so the LMS's same-origin checks and the links it builds use this port.
  // X-Forwarded-For is replaced, not appended to, so a browser cannot choose the address the LMS records.
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  headers['x-forwarded-proto'] = req.protocol;
  headers['x-forwarded-prefix'] = LMS_MOUNT;

  const upstream = http.request(
    { host: '127.0.0.1', port: config.lms.internalPort, method: req.method, path: url.slice(LMS_MOUNT.length), headers },
    (upstreamRes) => {
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) outHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, outHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[lms] Proxy error: ${err.code ?? err.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res
      .status(502)
      .type('html')
      .send('<!doctype html><meta charset="utf-8"><title>LMS unavailable</title><p>The LMS is not running or is still starting. Please try again in a moment.</p>');
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

/** Resolves true when something already answers on the LMS's internal port. */
function lmsResponding(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.get({ host: '127.0.0.1', port: config.lms.internalPort, path: '/api/session', timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    probe.on('timeout', () => probe.destroy());
    probe.on('error', () => resolve(false));
  });
}

/**
 * Starts the Python LMS on its loopback port, unless LMS_AUTOSTART=0 or an LMS is already running there
 * (for example one left behind when `tsx watch` restarted this server).
 */
export async function startLms(): Promise<void> {
  if (!config.lms.autostart) {
    console.log(`[lms] LMS_AUTOSTART=0: expecting the LMS on 127.0.0.1:${config.lms.internalPort}, served at ${LMS_MOUNT}/.`);
    return;
  }
  if (await lmsResponding()) {
    console.log(`[lms] Using the LMS already running on 127.0.0.1:${config.lms.internalPort}, served at ${LMS_MOUNT}/.`);
    return;
  }

  child = spawn(config.lms.python, ['backend/server.py', '--host', '127.0.0.1', '--port', String(config.lms.internalPort)], {
    cwd: lmsRoot,
    env: { ...process.env, PORT: String(config.lms.internalPort), LMS_BASE_PATH: LMS_MOUNT, LMS_TRUST_PROXY: '1', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[lms] ${line}`)
      .join('\n');
  child.stdout?.on('data', (chunk: Buffer) => console.log(prefix(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => console.error(prefix(chunk)));
  child.on('error', (err) => {
    console.error(`[lms] Could not start the LMS with "${config.lms.python}": ${err.message}. Set LMS_PYTHON in backend/.env, or LMS_AUTOSTART=0.`);
    child = undefined;
  });
  child.on('exit', (code, signal) => {
    if (child) console.error(`[lms] The LMS stopped (${signal ?? `exit code ${code}`}). /lms is unavailable until this server restarts.`);
    child = undefined;
  });
}

/** Stops the LMS process this server started, if any. */
export function stopLms(): void {
  const running = child;
  child = undefined;
  running?.kill();
}
