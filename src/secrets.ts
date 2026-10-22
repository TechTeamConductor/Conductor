import { spawn } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { paths, ensureHome } from './paths.ts';
import { atomicWriteFile, readJsonFile } from './util.ts';

export interface SecretStore {
  readonly kind: 'keychain' | 'file' | 'memory';
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = 'techteam-conductor';
/** Values we allow through `security -i` stdin quoting. Others fall back to the file store. */
const SAFE_VALUE = /^[A-Za-z0-9_\-.:=+/]{8,512}$/;

function execFileP(cmd: string, args: string[], input?: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** macOS Keychain via the `security` CLI. The secret travels over stdin (`security -i`), never argv. */
export class KeychainStore implements SecretStore {
  readonly kind = 'keychain' as const;
  private service: string;
  constructor(service: string = SERVICE) {
    this.service = service;
  }
  static available(): boolean {
    return process.platform === 'darwin' && existsSync('/usr/bin/security');
  }
  async get(name: string): Promise<string | null> {
    const r = await execFileP('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', name, '-w']);
    if (r.code !== 0) return null;
    const v = r.stdout.replace(/\r?\n$/, '');
    return v.length ? v : null;
  }
  async set(name: string, value: string): Promise<void> {
    if (!SAFE_VALUE.test(value)) throw new Error('value contains characters the Keychain path does not accept');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error('invalid secret name');
    const r = await execFileP('/usr/bin/security', ['-i'], `add-generic-password -U -s ${this.service} -a ${name} -w ${value}\n`);
    if (r.code !== 0 || /error|denied|unable/i.test(r.stderr)) throw new Error('Keychain write failed');
  }
  async delete(name: string): Promise<void> {
    await execFileP('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', name]);
  }
}

/** 0600 JSON file fallback (non-macOS, tests, or odd characters). */
export class FileStore implements SecretStore {
  readonly kind = 'file' as const;
  private path: string;
  constructor(path: string = paths.secrets()) {
    this.path = path;
  }
  async get(name: string): Promise<string | null> {
    const d = readJsonFile<Record<string, string>>(this.path, {});
    const v = d[name];
    return typeof v === 'string' && v ? v : null;
  }
  async set(name: string, value: string): Promise<void> {
    ensureHome();
    const d = readJsonFile<Record<string, string>>(this.path, {});
    d[name] = value;
    atomicWriteFile(this.path, JSON.stringify(d, null, 2) + '\n', 0o600);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort */
    }
  }
  async delete(name: string): Promise<void> {
    const d = readJsonFile<Record<string, string>>(this.path, {});
    delete d[name];
    if (Object.keys(d).length === 0) {
      try {
        if (existsSync(this.path)) unlinkSync(this.path);
      } catch {
        /* ignore */
      }
    } else atomicWriteFile(this.path, JSON.stringify(d, null, 2) + '\n', 0o600);
  }
}

export class MemoryStore implements SecretStore {
  readonly kind = 'memory' as const;
  private m = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    return this.m.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.m.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.m.delete(name);
  }
}

export function defaultSecretStore(): SecretStore {
  if (process.env.CONDUCTOR_NO_KEYCHAIN === '1' || !KeychainStore.available()) return new FileStore();
  return new KeychainStore();
}

/** Secret name → environment variable that overrides the stored value (registered by the code that owns the secret, e.g. a provider API key). */
const ENV_OVERRIDE: Record<string, string> = {};
export function registerSecretEnv(name: string, envVar: string): void {
  ENV_OVERRIDE[name] = envVar;
}

/** Env var wins; then the configured store (Keychain by default, file fallback if Keychain rejects the value). */
export async function getSecret(store: SecretStore, name: string): Promise<string | null> {
  const envName = ENV_OVERRIDE[name];
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const v = await store.get(name);
  if (v) return v;
  if (store.kind === 'keychain') return new FileStore().get(name);
  return null;
}

/** Store in Keychain when possible, otherwise the 0600 file. Returns where it went. */
export async function putSecret(store: SecretStore, name: string, value: string): Promise<'keychain' | 'file' | 'memory'> {
  try {
    await store.set(name, value);
    return store.kind;
  } catch {
    if (store.kind === 'keychain') {
      await new FileStore().set(name, value);
      return 'file';
    }
    throw new Error('could not store secret');
  }
}

export async function dropSecret(store: SecretStore, name: string): Promise<void> {
  await store.delete(name);
  if (store.kind === 'keychain') await new FileStore().delete(name);
}

