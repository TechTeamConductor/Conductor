// Project context facts (M4): the shape, and the ONE place that decides what a stored/produced fact may look like.
//
// Facts are derived mechanically from git objects. They never carry free-form prose from the repository: every name is an *identifier*
// (a strict charset, ≤ 120 chars, no space) or — only for read-only stages and the UI — a *command text* (≤ 200 chars, control and bidi
// characters stripped, whitespace collapsed). `normalizeFacts` is applied when facts are produced AND every time they are loaded: a builder
// can rewrite the on-disk cache, so nothing read from it is trusted until it has passed through here (plan §2b-8, C4-2).

export type ModuleKind = 'package' | 'app' | 'lib' | 'tests' | 'docs' | 'config';
export const MODULE_KINDS: readonly ModuleKind[] = ['package', 'app', 'lib', 'tests', 'docs', 'config'];

export interface ContextModule {
  /** Repo-relative directory, identifier charset (a nested workspace package is `top/sub`). */
  path: string;
  kind: ModuleKind;
  files: number;
  languages: string[];
  entryPoints: string[];
}
export interface ContextScript {
  /** Identifier. The only part of a script a builder prompt may receive. */
  name: string;
  /** Command text: read-only stages and the UI only, fenced as untrusted data. */
  command: string;
}
export interface ContextGate {
  name: string;
  kind: string;
  cmd: string;
}
export interface ContextFacts {
  schemaVersion: 1;
  /** extension → file count (≤ 12 entries). */
  languages: Record<string, number>;
  packageManagers: string[];
  frameworks: string[];
  scripts: ContextScript[];
  gates: ContextGate[];
  modules: ContextModule[];
  tests: { runner: string | null; dirs: string[]; fileCount: number };
  importantFiles: string[];
  ci: string[];
  conventionsFiles: string[];
  counts: { files: number; symlinks: number; submodules: number; truncated: boolean; dropped: number; moduleOverflow: number };
}

export const FACT_LIMITS = Object.freeze({
  ident: 120,
  command: 200,
  languages: 12,
  packageManagers: 8,
  frameworks: 40,
  scripts: 40,
  gates: 12,
  modules: 400,
  entryPoints: 6,
  moduleLanguages: 3,
  testDirs: 20,
  importantFiles: 40,
  ci: 20,
  conventionsFiles: 10,
  maxFiles: 200_000,
  /** The serialised facts file never exceeds this (plan §2.1). */
  factsBytes: 200 * 1024,
});

/** `[A-Za-z0-9._@/+:=-]`, 1–120 chars: cannot carry a sentence. */
export const IDENT_RE = /^[A-Za-z0-9._@/+:=-]{1,120}$/;
/** An identifier is repo-relative when used as a path: no leading `/`, no empty (`//`), `.` or `..` segment. */
export const isIdent = (s: unknown): s is string => typeof s === 'string' && IDENT_RE.test(s) && !s.startsWith('/') && !s.split('/').some((p) => p === '..' || p === '.' || p === '');
/** Control, bidi and format characters — stripped from any text that can reach a prompt, a card or the UI. */
/** Control, format (bidi, zero-width, Unicode tags …), separator, private-use and unassigned characters, plus invisible fillers and variation selectors. */
const FORMAT_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800]/gu;
export function cleanCommand(s: unknown): string {
  return String(s ?? '').replace(FORMAT_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, FACT_LIMITS.command);
}

type Counter = { dropped: number };
const ident = (s: unknown, c: Counter): string | null => {
  if (isIdent(s)) return s;
  c.dropped++;
  return null;
};
const identList = (v: unknown, max: number, c: Counter): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= max) {
      c.dropped++;
      continue;
    }
    const i = ident(x, c);
    if (i !== null && !out.includes(i)) out.push(i);
  }
  return out;
};
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : 0);
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);

/**
 * Build a valid `ContextFacts` from untrusted input (a scan result or a file read from disk). Unknown keys are ignored, every string is
 * checked, every list is capped; what does not pass is dropped and counted in `counts.dropped`. Idempotent. Never throws.
 */
export function normalizeFacts(raw: unknown): { facts: ContextFacts; dropped: number } {
  const c: Counter = { dropped: 0 };
  const languages: Record<string, number> = Object.create(null);
  const langRaw = own(raw, 'languages');
  if (langRaw && typeof langRaw === 'object' && !Array.isArray(langRaw)) {
    const entries = Object.keys(langRaw as object)
      .filter((k) => Object.hasOwn(langRaw as object, k))
      .map((k) => [k, count((langRaw as Record<string, unknown>)[k])] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [k, n] of entries) {
      if (Object.keys(languages).length >= FACT_LIMITS.languages || !/^[a-z0-9]{1,8}$/.test(k) || n <= 0) {
        c.dropped++;
        continue;
      }
      languages[k] = n;
    }
  }

  const scripts: ContextScript[] = [];
  const scriptsRaw = own(raw, 'scripts');
  for (const s of Array.isArray(scriptsRaw) ? scriptsRaw : []) {
    if (scripts.length >= FACT_LIMITS.scripts) {
      c.dropped++;
      continue;
    }
    const name = ident(own(s, 'name'), c);
    if (name === null) continue;
    scripts.push({ name, command: cleanCommand(own(s, 'command')) });
  }

  const gates: ContextGate[] = [];
  const gatesRaw = own(raw, 'gates');
  for (const g of Array.isArray(gatesRaw) ? gatesRaw : []) {
    if (gates.length >= FACT_LIMITS.gates) {
      c.dropped++;
      continue;
    }
    const name = ident(own(g, 'name'), c);
    const kind = ident(own(g, 'kind'), c);
    if (name === null || kind === null) continue;
    gates.push({ name, kind, cmd: cleanCommand(own(g, 'cmd')) });
  }

  const modules: ContextModule[] = [];
  const modsRaw = own(raw, 'modules');
  for (const m of Array.isArray(modsRaw) ? modsRaw : []) {
    if (modules.length >= FACT_LIMITS.modules) {
      c.dropped++;
      continue;
    }
    const path = ident(own(m, 'path'), c);
    const kindRaw = own(m, 'kind');
    if (path === null) continue;
    if (!MODULE_KINDS.includes(kindRaw as ModuleKind)) {
      c.dropped++;
      continue;
    }
    modules.push({
      path,
      kind: kindRaw as ModuleKind,
      files: count(own(m, 'files')),
      languages: identList(own(m, 'languages'), FACT_LIMITS.moduleLanguages, c),
      entryPoints: identList(own(m, 'entryPoints'), FACT_LIMITS.entryPoints, c),
    });
  }

  const testsRaw = own(raw, 'tests');
  const runnerRaw = own(testsRaw, 'runner');
  const countsRaw = own(raw, 'counts');
  const facts: ContextFacts = {
    schemaVersion: 1,
    languages,
    packageManagers: identList(own(raw, 'packageManagers'), FACT_LIMITS.packageManagers, c),
    frameworks: identList(own(raw, 'frameworks'), FACT_LIMITS.frameworks, c),
    scripts,
    gates,
    modules,
    tests: { runner: runnerRaw === null || runnerRaw === undefined ? null : ident(runnerRaw, c), dirs: identList(own(testsRaw, 'dirs'), FACT_LIMITS.testDirs, c), fileCount: count(own(testsRaw, 'fileCount')) },
    importantFiles: identList(own(raw, 'importantFiles'), FACT_LIMITS.importantFiles, c),
    ci: identList(own(raw, 'ci'), FACT_LIMITS.ci, c),
    conventionsFiles: identList(own(raw, 'conventionsFiles'), FACT_LIMITS.conventionsFiles, c),
    counts: {
      files: count(own(countsRaw, 'files')),
      symlinks: count(own(countsRaw, 'symlinks')),
      submodules: count(own(countsRaw, 'submodules')),
      truncated: own(countsRaw, 'truncated') === true,
      dropped: 0,
      moduleOverflow: count(own(countsRaw, 'moduleOverflow')),
    },
  };
  // strings already counted as dropped by an earlier normalisation stay counted (the count only grows through repeated passes of fresh data)
  facts.counts.dropped = count(own(countsRaw, 'dropped')) + c.dropped;
  return { facts, dropped: c.dropped };
}

/** A stable empty fact set (an empty repository). */
export const emptyFacts = (): ContextFacts => normalizeFacts({}).facts;
