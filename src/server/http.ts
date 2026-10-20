import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStore } from '../store.ts';
import type { Engine } from '../pipeline/engine.ts';
import { logger } from '../log.ts';
import { errMsg } from '../util.ts';
import { Api, ApiFail } from './api.ts';
import { Auth, COOKIE_NAME, clearCookie, parseCookies, sessionCookie } from './auth.ts';

const log = logger('http');
const MAX_BODY = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/** Exact static whitelist — there is no directory serving, so traversal is impossible by construction. */
const STATIC: Record<string, { file: string; type: string; public: boolean }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', public: false },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8', public: false },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8', public: true },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', public: true },
};

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conductor — sign in</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg"></head><body><main><h1>Conductor</h1><p>This dashboard is private to your Mac. To open it, run this in a terminal:</p><pre><code>npm run open</code></pre><p>(or <code>conductor open</code>). It opens a fresh signed-in tab — the link works once.</p></main></body></html>`;

export interface ServerDeps {
  api: Api;
  auth: Auth;
  store: RunStore;
  engine: Engine;
  uiDir: string;
}

type Sse = { res: http.ServerResponse; alive: boolean };

export class DashboardServer {
  readonly server: http.Server;
  private control: http.Server | null = null;
  private d: ServerDeps;
  private port = 0;
  private clients = new Set<Sse>();
  private stateTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private unsubs: (() => void)[] = [];
  private sockPath: string | null = null;

  constructor(deps: ServerDeps) {
    this.d = deps;
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on('clientError', (_e, socket) => socket.destroy());
  }

  get listeningPort(): number {
    return this.port;
  }

  async listen(port: number, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.unsubs.push(
      this.d.store.on((e) => {
        if (e.type === 'log') this.broadcast('log', { key: e.key, event: e.event });
        else this.scheduleState();
      }),
    );
    this.unsubs.push(this.d.engine.onChange(() => this.scheduleState()));
    this.pingTimer = setInterval(() => this.broadcast('ping', { now: Date.now() }), 20_000);
    this.pingTimer.unref();
    return this.port;
  }

  /** Unix-socket control channel (0600): `conductor open` asks for a one-time sign-in link. */
  async listenControl(sockPath: string): Promise<void> {
    if (existsSync(sockPath)) {
      try {
        unlinkSync(sockPath);
      } catch {
        /* stale */
      }
    }
    this.sockPath = sockPath;
    this.control = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/otp') {
        res.end(JSON.stringify({ url: this.loginUrl() }));
      } else if (req.method === 'GET' && req.url === '/status') {
        res.end(JSON.stringify({ pid: process.pid, port: this.port }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.control!.once('error', reject);
      this.control!.listen(sockPath, () => resolve());
    });
    try {
      chmodSync(sockPath, 0o600);
    } catch {
      /* best effort */
    }
  }

  loginUrl(): string {
    return `http://127.0.0.1:${this.port}/auth?otp=${this.d.auth.mintOtp()}`;
  }

  toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.broadcast('toast', { level, text });
  }

  async close(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.clients) {
      c.alive = false;
      c.res.end();
    }
    this.clients.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
    if (this.control) {
      this.control.closeAllConnections?.();
      await new Promise<void>((r) => this.control!.close(() => r()));
      if (this.sockPath && existsSync(this.sockPath)) {
        try {
          unlinkSync(this.sockPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ───────────────────────── SSE ─────────────────────────
  private broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      if (c.alive) c.res.write(frame);
    }
  }
  private scheduleState(): void {
    if (this.stateTimer || !this.clients.size) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      try {
        this.broadcast('state', this.d.api.live());
      } catch (e) {
        log.warn(`state broadcast failed: ${errMsg(e)}`);
      }
    }, 250);
    this.stateTimer.unref();
  }

  // ───────────────────────── request handling ─────────────────────────
  private hostOk(host: string): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private send(res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
    res.end(body);
  }
  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
    this.send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', extra);
  }
  private fail(res: http.ServerResponse, status: number, code: string, message: string): void {
    this.json(res, status, { error: { code, message } });
  }

  private async readBody(req: http.IncomingMessage): Promise<{ ok: true; body: any } | { ok: false; status: number; code: string; message: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return { ok: false, status: 413, code: 'too_large', message: 'Request body is too large (max 1 MB).' };
      chunks.push(c as Buffer);
    }
    if (!size) return { ok: true, body: {} };
    try {
      return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { ok: false, status: 400, code: 'bad_json', message: 'Body is not valid JSON.' };
    }
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const host = String(req.headers.host ?? '');
      if (!this.hostOk(host)) return this.fail(res, 421, 'bad_host', 'Unexpected Host header.');
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = (req.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
      const authed = this.d.auth.validSession(sid);

      // ── public routes
      if (method === 'GET' && path === '/login') return this.send(res, 200, LOGIN_PAGE, 'text/html; charset=utf-8');
      if (method === 'GET' && path === '/auth') {
        const s = this.d.auth.consumeOtp(url.searchParams.get('otp') ?? '');
        if (!s) return this.send(res, 403, LOGIN_PAGE.replace('<p>This dashboard', '<p><strong>That sign-in link has expired or was already used.</strong></p><p>This dashboard'), 'text/html; charset=utf-8');
        return this.send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': sessionCookie(s) });
      }
      const st = method === 'GET' || method === 'HEAD' ? STATIC[path] : undefined;
      if (st && st.public) return this.serveStatic(res, st);

      // ── everything else needs a session
      if (!authed) {
        if (path.startsWith('/api/')) return this.fail(res, 401, 'unauthorized', 'Session expired — run "conductor open" (npm run open) in a terminal.');
        if (method === 'GET' && st) return this.send(res, 302, '', 'text/plain', { Location: '/login' });
        return this.fail(res, 401, 'unauthorized', 'Sign in first.');
      }
      if (st) return this.serveStatic(res, st);
      if (!path.startsWith('/api/')) return this.fail(res, 404, 'not_found', 'Not found.');

      if (method === 'GET' && path === '/api/events') return this.openStream(req, res);

      if (method === 'GET') return this.runApi(res, method, path, url.searchParams, {}, sid);

      // ── mutations: JSON only, same-origin only, CSRF header
      if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return this.fail(res, 405, 'method', 'Method not allowed.');
      if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) return this.fail(res, 415, 'content_type', 'Use Content-Type: application/json.');
      if (req.headers['x-conductor-csrf'] !== this.d.auth.csrf) return this.fail(res, 403, 'csrf', 'Missing or wrong CSRF token — reload the page.');
      const sfs = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      if (typeof sfs === 'string') {
        if (sfs !== 'same-origin' && sfs !== 'none') return this.fail(res, 403, 'cross_site', 'Cross-site requests are not allowed.');
      } else if (typeof origin === 'string') {
        if (origin !== `http://${host}`) return this.fail(res, 403, 'cross_site', 'Cross-origin requests are not allowed.');
      } else return this.fail(res, 403, 'cross_site', 'Requests must come from the dashboard.');
      const b = await this.readBody(req);
      if (!b.ok) return this.fail(res, b.status, b.code, b.message);
      return this.runApi(res, method, path, url.searchParams, b.body, sid);
    } catch (e) {
      log.error(`request failed: ${errMsg(e)}`);
      if (!res.headersSent) this.fail(res, 500, 'internal', 'Something went wrong inside Conductor (details are in the log).');
      else res.end();
    }
  }

  private async runApi(res: http.ServerResponse, method: string, path: string, q: URLSearchParams, body: unknown, sid: string | undefined): Promise<void> {
    try {
      const r = await this.d.api.handle(method, path, q, body);
      if (r.logout) {
        this.d.auth.revoke(sid);
        return this.json(res, r.status ?? 200, r.json ?? { ok: true }, { 'Set-Cookie': clearCookie() });
      }
      return this.json(res, r.status ?? 200, r.json ?? { ok: true });
    } catch (e) {
      if (e instanceof ApiFail) return this.fail(res, e.status, e.code, e.message);
      log.error(`api ${method} ${path} failed: ${errMsg(e)}`);
      return this.fail(res, 500, 'internal', 'Something went wrong inside Conductor (details are in the log).');
    }
  }

  private serveStatic(res: http.ServerResponse, s: { file: string; type: string }): void {
    try {
      const body = readFileSync(join(this.d.uiDir, s.file));
      this.send(res, 200, body, s.type);
    } catch {
      this.fail(res, 404, 'not_found', `UI file ${s.file} is missing.`);
    }
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const c: Sse = { res, alive: true };
    this.clients.add(c);
    res.write(`event: state\ndata: ${JSON.stringify(this.d.api.live())}\n\n`);
    req.on('close', () => {
      c.alive = false;
      this.clients.delete(c);
    });
  }
}
