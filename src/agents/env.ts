import { delimiter } from 'node:path';
import { searchPath } from '../config.ts';

/** Variables every child may receive. Everything else is dropped (allowlist). */
const BASE_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];
const CLAUDE_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
];
const CURSOR_KEYS = ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'];

function pick(keys: readonly string[], src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.length) out[k] = v;
  }
  return out;
}

export function baseEnv(extra: Record<string, string> = {}, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...pick(BASE_KEYS, src),
    PATH: [...new Set([...(src.PATH ?? '').split(delimiter).filter(Boolean), ...searchPath()])].join(delimiter),
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

/** Env for `claude` children: Anthropic/Claude credentials only; no Cursor/Linear secrets. */
export function claudeEnv(extra: Record<string, string> = {}, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const anthropic: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (k.startsWith('ANTHROPIC_') && typeof v === 'string' && v) anthropic[k] = v;
  return baseEnv(
    { ...pick(CLAUDE_KEYS, src), ...anthropic, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', ...extra },
    src,
  );
}

/** Env for `agent` (Cursor) children: Cursor credentials only; no Claude/Linear secrets. */
export function cursorEnv(extra: Record<string, string> = {}, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return baseEnv({ ...pick(CURSOR_KEYS, src), ...extra }, src);
}

/** Env for gates / dependency installs: base + explicitly passed-through names only. */
export function toolEnv(passthrough: readonly string[] = [], src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return baseEnv({ ...pick(passthrough, src), CI: '1' }, src);
}
