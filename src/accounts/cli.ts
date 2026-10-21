// `conductor accounts add|login|list|check|move|remove` (M8-3 §2.8; Security S11, S13). Single writer of config: with a server running
// (it holds the lock) every change goes through the 0600 control socket (the SAME strict handlers as the API); without one, the CLI holds the
// lock for the whole read-modify-write (and the whole removal sequence) and writes the config itself. `login` writes no config, never goes
// through the server, and is DISABLED in this slice (awaiting live checks L2 / L4b).
import http from 'node:http';
import type { AccountView } from '../types.ts';
import { LOGIN_DISABLED_MESSAGE, ACCOUNT_LOGIN_ENABLED, AccountError, type AccountService } from './service.ts';

export const ACCOUNTS_HELP = `Usage: conductor accounts <command>

  list [--json]                         every sign-in of every tool, in the order Conductor tries them
  add <claude|cursor> --name "<label>"  add another account (an empty private folder; nothing is signed in yet)
  login <id>                            sign an added account in with the tool's own login (not enabled yet)
  check [<id>]                          ask the tool whether the account is signed in (no quota)
  move <id> up|down                     change the order
  remove <id> [--keep-signin]           sign the account out, delete its folder and forget it
`;

export interface ControlClient {
  (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
}
export interface AccountsCliDeps {
  /** A running server's control socket, or null (direct mode). */
  control: ControlClient | null;
  /** Direct mode: the lock is taken for the whole command; `release` frees it. */
  direct: () => Promise<{ svc: AccountService; release: () => void }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** A unix-socket JSON client (5 s connect / 30 s total; removal can sign out for up to 20 s). */
export function socketClient(socketPath: string): ControlClient {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ socketPath, path, method, timeout: 30_000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : {} });
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      if (data) req.write(data);
      req.end();
    });
}

const STATUS_WORDS: Record<AccountView['status'], string> = {
  ready: 'Ready', 'in-use': 'In use', 'at-limit': 'At its limit', 'not-signed-in': 'Not signed in', 'not-installed': 'Not installed', checking: 'Checking', unknown: 'Unknown', unavailable: 'Unavailable',
};
function printList(views: AccountView[], json: boolean, out: (l: string) => void, extra: Record<string, unknown> = {}): void {
  if (json) return out(JSON.stringify({ accounts: views, ...extra }, null, 2));
  for (const v of views) {
    const until = v.until ? ` until ${new Date(v.until).toLocaleString()}` : '';
    out(`${v.provider.padEnd(7)} ${String(v.order + 1).padStart(2)}. ${v.name.padEnd(24)} ${v.id.padEnd(28)} ${STATUS_WORDS[v.status]}${until}${v.note ? ` — ${v.note}` : ''}`);
    if (v.status === 'not-signed-in' && !v.isDefault) out(`           sign in: ${v.signInCommand}`);
  }
}

/** Returns the exit code. */
export async function accountsCli(args: readonly string[], d: AccountsCliDeps): Promise<number> {
  const [sub, ...rest] = args;
  const flag = (n: string) => rest.includes(n);
  const opt = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const fail = (m: string, code = 1) => {
    d.err(m);
    return code;
  };
  const viaControl = async (method: string, path: string, body?: unknown) => {
    const r = await d.control!(method, path, body);
    if (r.status >= 400) throw new AccountError(r.status, r.json?.error?.code ?? 'error', String(r.json?.error?.message ?? 'The request failed.'));
    return r.json;
  };
  const direct = async <T>(fn: (svc: AccountService) => Promise<T> | T): Promise<T> => {
    const { svc, release } = await d.direct();
    try {
      return await fn(svc);
    } finally {
      release();
    }
  };
  try {
    switch (sub) {
      case 'list': {
        const j = d.control ? await viaControl('GET', '/accounts') : await direct((s) => s.listing());
        printList(j.accounts, flag('--json'), d.out, flag('--json') ? { limitRule: j.limitRule, limitRuleEffective: j.limitRuleEffective } : {});
        return 0;
      }
      case 'add': {
        const provider = rest[0];
        const name = opt('--name');
        if (!provider || name === undefined) return fail('Usage: conductor accounts add <claude|cursor> --name "<label>"', 2);
        const body = { provider, name };
        const j = d.control ? await viaControl('POST', '/accounts', body) : await direct((s) => s.add(body));
        d.out(`Added ${j.account.name} (${j.account.id}). It is not signed in yet.`);
        d.out(ACCOUNT_LOGIN_ENABLED ? `Sign it in with:  ${j.signInCommand}` : LOGIN_DISABLED_MESSAGE);
        return 0;
      }
      case 'login': {
        const id = rest[0];
        if (!id) return fail('Usage: conductor accounts login <id>', 2);
        if (id === 'default') return fail("The main sign-in of each tool uses the tool's own command: `claude auth login` or `agent login`. Conductor never runs it for you.");
        if (!ACCOUNT_LOGIN_ENABLED) return fail(LOGIN_DISABLED_MESSAGE);
        return fail(LOGIN_DISABLED_MESSAGE); // the enabled path (inherited stdio, then a check) ships with the L2/L4b follow-up
      }
      case 'check': {
        const id = rest[0];
        const ids: string[] = id ? [id] : (d.control ? (await viaControl('GET', '/accounts')).accounts : await direct((s) => s.list())).filter((v: AccountView) => !v.isDefault && v.provider !== 'codex').map((v: AccountView) => v.id);
        for (const x of ids) {
          const v: AccountView = d.control ? (await viaControl('POST', `/accounts/${encodeURIComponent(x)}/check`, {})).account : await direct((s) => s.check(x));
          d.out(`${v.name} (${v.id}): ${STATUS_WORDS[v.status]}`);
        }
        if (!ids.length) d.out('No added accounts to check. The main sign-ins are checked by `conductor doctor`.');
        return 0;
      }
      case 'move': {
        const [id, dir] = rest;
        if (!id || (dir !== 'up' && dir !== 'down')) return fail('Usage: conductor accounts move <id> up|down', 2);
        if (d.control) {
          const list: AccountView[] = (await viaControl('GET', '/accounts')).accounts;
          const me = list.find((v) => v.id === id);
          if (!me) return fail('No such account.');
          const ids = list.filter((v) => v.provider === me.provider).map((v) => v.id);
          const i = ids.indexOf(id);
          const j = dir === 'up' ? i - 1 : i + 1;
          if (j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j]!, ids[i]!];
          await viaControl('PUT', '/accounts/order', { provider: me.provider, ids });
        } else {
          await direct((s) => s.move(id, dir));
        }
        d.out(`Moved ${id} ${dir}.`);
        return 0;
      }
      case 'remove': {
        const id = rest[0];
        if (!id) return fail('Usage: conductor accounts remove <id> [--keep-signin]', 2);
        const keep = flag('--keep-signin');
        const j = d.control ? await viaControl('DELETE', `/accounts/${encodeURIComponent(id)}`, keep ? { keepSignin: true } : {}) : await direct((s) => s.remove(id, { keepSignin: keep }));
        d.out(`Removed ${id}.${j.signedOut === true ? ' It was signed out.' : j.signedOut === null ? ' The sign-in was kept (--keep-signin).' : ''}`);
        if (j.note) d.out(j.note);
        return 0;
      }
      default:
        d.out(ACCOUNTS_HELP);
        return sub ? 2 : 0;
    }
  } catch (e) {
    if (e instanceof AccountError) return fail(e.message);
    return fail(`Could not complete the command: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}
