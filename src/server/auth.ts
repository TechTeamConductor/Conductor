import { atomicWriteFile, randomToken, readJsonFile, sha256 } from '../util.ts';

export const COOKIE_NAME = 'conductor_session';

export interface AuthOptions {
  otpTtlMs?: number;
  now?: () => number;
  /** When set, signed-in sessions survive restarts (only SHA-256 hashes are stored, file mode 0600). */
  persistPath?: string;
}

/** One-time-link → session-cookie auth for the loopback dashboard (RC5). */
export class Auth {
  /** CSRF token handed to authenticated clients via /api/state; mutations must echo it in X-Conductor-CSRF. */
  readonly csrf: string = randomToken(24);
  private otps = new Map<string, number>();
  /** SHA-256 hash of the session id → created / last-used (never the ids themselves). */
  private sessions = new Map<string, { c: number; l: number }>();
  private lastSave = 0;
  private ttl: number;
  private now: () => number;
  private persistPath: string | undefined;

  constructor(opts: AuthOptions = {}) {
    this.ttl = opts.otpTtlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.persistPath = opts.persistPath;
    if (this.persistPath) {
      const raw = readJsonFile<unknown>(this.persistPath, []);
      const t = this.now();
      if (Array.isArray(raw)) {
        for (const h of raw) if (typeof h === 'string') this.sessions.set(h, { c: t, l: t }); // v1 file: hashes only
      } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).sessions)) {
        for (const s of (raw as any).sessions) if (s && typeof s.h === 'string' && Number.isFinite(s.c) && Number.isFinite(s.l)) this.sessions.set(s.h, { c: s.c, l: s.l });
      }
    }
  }
  /** Sessions end 14 days after sign-in, or after 3 days without use. */
  static readonly ABSOLUTE_MS = 14 * 24 * 3600_000;
  static readonly IDLE_MS = 3 * 24 * 3600_000;

  private save(): void {
    if (!this.persistPath) return;
    try {
      const list = [...this.sessions].slice(-20).map(([h, v]) => ({ h, c: v.c, l: v.l }));
      atomicWriteFile(this.persistPath, JSON.stringify({ v: 2, sessions: list }) + '\n', 0o600);
    } catch {
      /* sessions then simply do not survive a restart */
    }
  }

  mintOtp(): string {
    const otp = randomToken(24);
    this.otps.set(otp, this.now() + this.ttl);
    for (const [k, exp] of this.otps) if (exp < this.now()) this.otps.delete(k);
    return otp;
  }

  /** Single use. Returns a new session id or null. */
  consumeOtp(otp: string): string | null {
    const exp = this.otps.get(otp);
    this.otps.delete(otp);
    if (exp === undefined || exp < this.now()) return null;
    const sid = randomToken(32);
    this.sessions.set(sha256(sid), { c: this.now(), l: this.now() });
    this.save();
    return sid;
  }

  validSession(sid: string | undefined): boolean {
    if (!sid) return false;
    const h = sha256(sid);
    const s = this.sessions.get(h);
    if (!s) return false;
    const t = this.now();
    if (t - s.c > Auth.ABSOLUTE_MS || t - s.l > Auth.IDLE_MS) {
      this.sessions.delete(h);
      this.save();
      return false;
    }
    s.l = t;
    if (t - this.lastSave > 60_000) {
      this.lastSave = t;
      this.save();
    }
    return true;
  }
  revoke(sid: string | undefined): void {
    if (sid && this.sessions.delete(sha256(sid))) this.save();
  }
  sessionCount(): number {
    return this.sessions.size;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function sessionCookie(sid: string): string {
  return `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600`;
}
export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
