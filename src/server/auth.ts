import { randomToken } from '../util.ts';

export const COOKIE_NAME = 'conductor_session';

export interface AuthOptions {
  otpTtlMs?: number;
  now?: () => number;
}

/** One-time-link → session-cookie auth for the loopback dashboard (RC5). */
export class Auth {
  /** CSRF token handed to authenticated clients via /api/state; mutations must echo it in X-Conductor-CSRF. */
  readonly csrf: string = randomToken(24);
  private otps = new Map<string, number>();
  private sessions = new Set<string>();
  private ttl: number;
  private now: () => number;

  constructor(opts: AuthOptions = {}) {
    this.ttl = opts.otpTtlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
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
    this.sessions.add(sid);
    return sid;
  }

  validSession(sid: string | undefined): boolean {
    return !!sid && this.sessions.has(sid);
  }
  revoke(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
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
  return `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}
export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
