import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomToken } from '../util.ts';
import type { RunStore } from '../store.ts';
import type { Engine } from '../pipeline/engine.ts';
import { logger } from '../log.ts';
import { errMsg } from '../util.ts';
import { Api, ApiFail, accountRoute } from './api.ts';
import { AccountError } from '../accounts/service.ts';

/** M8-3 S11: control-socket account routes — an exact method + path allow-list, ≤ 16 KB JSON bodies, no login route. */
export const CONTROL_BODY_MAX = 16 * 1024;
const CONTROL_ID = '[a-z0-9][a-z0-9-]{0,31}';
export const CONTROL_ROUTES: readonly { method: string; re: RegExp }[] = Object.freeze([
  { method: 'GET', re: /^\/accounts$/ },
  { method: 'POST', re: /^\/accounts$/ },
  { method: 'PUT', re: /^\/accounts\/order$/ },
  { method: 'PUT', re: new RegExp(`^/accounts/${CONTROL_ID}$`) },
  { method: 'POST', re: new RegExp(`^/accounts/${CONTROL_ID}/check$`) },
  { method: 'DELETE', re: new RegExp(`^/accounts/${CONTROL_ID}$`) },
]);
/** S11: `<home>/run` must be a real directory owned by the user with mode 0700, or no socket is opened. */
export function controlDirOk(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}
import { Auth, COOKIE_NAME, clearCookie, parseCookies, sessionCookie } from './auth.ts';

const log = logger('http');
const MAX_BODY = 1024 * 1024;
const MAX_SSE = 50;

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
  '/modes.js': { file: 'modes.js', type: 'text/javascript; charset=utf-8', public: false },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8', public: true },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', public: true },
};

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conductor — sign in</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg"></head><body><main><h1>Conductor</h1><p>This dashboard is private to your Mac. To open it, run this in a terminal:</p><pre><code>conductor open</code></pre><p>It opens a fresh signed-in tab — the link works once.</p></main></body></html>`;

export interface ServerDeps {
  api: Api;
  auth: Auth;
  store: RunStore;
  engine: Engine;
  uiDir: string;
}

type Sse = { res: http.ServerResponse; alive: boolean };

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function rmQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

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
  private bridgeDir: string | null = null;

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
    const dir = dirname(sockPath);
    try {
      if (existsSync(dir) && !lstatSync(dir).isSymbolicLink() && (lstatSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } catch {
      /* verified below */
    }
    if (!controlDirOk(dir)) throw new Error('the run folder is not a private directory owned by you (mode 0700); the control socket was not opened');
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
        res.end(JSON.stringify({ url: this.loginUrl(), file: this.loginFile(this.sockPath ? dirname(this.sockPath) : '') }));
      } else if (req.method === 'GET' && req.url === '/status') {
        res.end(JSON.stringify({ pid: process.pid, port: this.port }));
      } else if (CONTROL_ROUTES.some((r) => r.method === req.method && r.re.test(req.url ?? ''))) {
        void this.controlAccounts(req, res);
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

  /** The same strict handlers as `/api/accounts…` (shared `accountRoute`), on the same-user 0600 socket. */
  private async controlAccounts(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    try {
      let body: unknown = {};
      if (req.method !== 'GET') {
        const type = String(req.headers['content-type'] ?? '');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > CONTROL_BODY_MAX) return send(413, { error: { code: 'too_large', message: 'Request too large.' } });
          chunks.push(c as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length) {
          if (!/^application\/json\b/i.test(type)) return send(415, { error: { code: 'bad_request', message: 'Send application/json.' } });
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: { code: 'bad_request', message: 'Malformed JSON.' } });
          }
        }
      }
      const svc = this.d.api.accountsService();
      if (!svc) return send(501, { error: { code: 'not_available', message: 'Accounts are not available in this mode.' } });
      const out = await accountRoute(svc, req.method ?? 'GET', req.url ?? '', body, { cli: true });
      if (!out) return send(404, {});
      return send(out.status ?? 200, out.json ?? {});
    } catch (e) {
      if (e instanceof AccountError || e instanceof ApiFail) return send(e.status, { error: { code: e.code, message: e.message } });
      log.warn(`control: accounts route failed: ${errMsg(e).slice(0, 120)}`);
      return send(500, { error: { code: 'internal', message: 'Internal error.' } });
    }
  }

  loginUrl(): string {
    return `http://127.0.0.1:${this.port}/auth?otp=${this.d.auth.mintOtp()}`;
  }

  /**
   * H4: the one-time code must not appear on a command line (visible to every process of this user via `ps`).
   * Write a private 0600 page that POSTs it to /auth and open THAT file instead.
   */
  loginFile(dir: string): string {
    if (!dir) return '';
    this.bridgeDir = dir;
    for (const f of safeList(dir)) if (/^open-[a-f0-9]+\.html$/.test(f)) rmQuiet(join(dir, f));
    const file = join(dir, `open-${randomToken(8).replace(/[^a-f0-9]/gi, 'a').toLowerCase()}.html`);
    const otp = this.d.auth.mintOtp();
    const page = `<!doctype html><meta charset="utf-8"><title>Opening Conductor…</title><body style="font:15px system-ui;margin:3em">Opening Conductor…<form id="f" method="post" action="http://127.0.0.1:${this.port}/auth"><input type="hidden" name="otp" value="${otp}"><noscript><button>Continue</button></noscript></form><script>document.getElementById('f').submit()</script></body>`;
    writeFileSync(file, page, { mode: 0o600 });
    const t = setTimeout(() => rmQuiet(file), 120_000);
    t.unref();
    return file;
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
  /** `{ error: { code, message, field?, …extra } }` — field omitted when undefined (M8-2 B1e); extra can never override code/message/field. */
  private fail(res: http.ServerResponse, status: number, code: string, message: string, field?: string, extra?: Record<string, unknown>): void {
    const ex: Record<string, unknown> = {};
    if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (k !== 'code' && k !== 'message' && k !== 'field' && k !== '__proto__') ex[k] = v;
    this.json(res, status, { error: { ...ex, code, message, ...(field !== undefined ? { field } : {}) } });
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
      const rawUrl = req.url ?? '/';
      // `GET //` makes `new URL()` treat the path as a host and throw (M11) — reject quietly instead of logging an error
      if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.length > 4096) return this.fail(res, 400, 'bad_request', 'Bad request.');
      const url = new URL(rawUrl, `http://${host}`);
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
      if (method === 'POST' && path === '/auth') {
        // form-encoded (the bridge page); one-time code only. A fresh session is returned with a 200 + meta refresh, because
        // a redirect would stay a cross-site navigation and the SameSite=Strict cookie would not be sent with it.
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req) {
          n += (c as Buffer).length;
          if (n > 4096) return this.fail(res, 413, 'too_large', 'Too large.');
          chunks.push(c as Buffer);
        }
        const s = this.d.auth.consumeOtp(new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('otp') ?? '');
        if (!s) return this.send(res, 403, LOGIN_PAGE.replace('<p>This dashboard', '<p><strong>That sign-in link has expired or was already used.</strong></p><p>This dashboard'), 'text/html; charset=utf-8');
        const dir = this.bridgeDir ?? '';
        if (dir) for (const f of safeList(dir)) if (/^open-[a-f0-9]+\.html$/.test(f)) rmQuiet(join(dir, f));
        return this.send(res, 200, '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Signed in</title><a href="/">Continue</a>', 'text/html; charset=utf-8', { 'Set-Cookie': sessionCookie(s) });
      }
      const st = method === 'GET' || method === 'HEAD' ? STATIC[path] : undefined;
      if (st && st.public) return this.serveStatic(res, st);

      // ── everything else needs a session
      if (!authed) {
        if (path.startsWith('/api/')) return this.fail(res, 401, 'unauthorized', 'Session expired — run "conductor open" in a terminal.');
        if (method === 'GET' && st) return this.send(res, 302, '', 'text/plain', { Location: '/login' });
        return this.fail(res, 401, 'unauthorized', 'Sign in first.');
      }
      if (st) return this.serveStatic(res, st);
      if (!path.startsWith('/api/')) return this.fail(res, 404, 'not_found', 'Not found.');

      // reads are not CSRF-exposed to cross-origin pages (no CORS), but a cross-site <img>/fetch could still trigger SSE/GETs: refuse them
      const sfsGet = req.headers['sec-fetch-site'];
      if (method === 'GET' && typeof sfsGet === 'string' && sfsGet !== 'same-origin' && sfsGet !== 'none') return this.fail(res, 403, 'cross_site', 'Cross-site requests are not allowed.');
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
      if (e instanceof ApiFail) return this.fail(res, e.status, e.code, e.message, e.field, e.extra);
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
    if (this.clients.size >= MAX_SSE) return this.fail(res, 503, 'busy', 'Too many open dashboard tabs.');
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
