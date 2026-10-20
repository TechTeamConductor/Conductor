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
  private sessions = new Set<string>(); // SHA-256 hashes of valid session ids (never the ids themselves)
  private ttl: number;
  private now: () => number;
  private persistPath: string | undefined;

  constructor(opts: AuthOptions = {}) {
    this.ttl = opts.otpTtlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.persistPath = opts.persistPath;
    if (this.persistPath) for (const h of readJsonFile<string[]>(this.persistPath, [])) if (typeof h === 'string') this.sessions.add(h);
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      atomicWriteFile(this.persistPath, JSON.stringify([...this.sessions].slice(-20)) + '\n', 0o600);
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
    this.sessions.add(sha256(sid));
    this.save();
    return sid;
  }

  validSession(sid: string | undefined): boolean {
    return !!sid && this.sessions.has(sha256(sid));
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
  return `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}
export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
