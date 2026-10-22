// The project-context scanner (M4): deterministic facts from git OBJECTS. No file of the working tree is read, no symlink is followed, no
// submodule entered, nothing executed. The unit of work (and of caching) is a TOP-LEVEL DIRECTORY identified by its git tree id: an
// unchanged tree id means its scan can be reused without touching its contents; the repository root contributes its own (non-recursive)
// listing plus a handful of manifest blobs.
import type { GateDef } from '../types.ts';
import { FACT_LIMITS, cleanCommand, isIdent, normalizeFacts, type ContextFacts, type ContextModule, type ContextScript, type ModuleKind } from './facts.ts';
import type { GitSource, TreeEntry } from './gitread.ts';

export const SCAN_LIMITS = Object.freeze({
  /** Top-level directories scanned per refresh; the rest are only counted. */
  maxTopDirs: 200,
  /** Manifest/config blobs read per module and at the root. */
  maxBlobsPerModule: 24,
  maxBlobBytes: 256 * 1024,
  /** Workspace packages recorded per top-level directory. */
  maxChildren: 40,
});

/** Files whose CONTENT is read (names only are ever recorded from the rest). */
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Makefile']);
export const ROOT_MANIFESTS: readonly string[] = [...MANIFESTS];

// dependency name → framework/tool label (names only; the label list is a code constant)
const NODE_FRAMEWORKS: Record<string, string> = {
  react: 'react', next: 'next', vue: 'vue', nuxt: 'nuxt', svelte: 'svelte', '@angular/core': 'angular', express: 'express', fastify: 'fastify', koa: 'koa', '@nestjs/core': 'nestjs',
  electron: 'electron', vite: 'vite', webpack: 'webpack', jest: 'jest', vitest: 'vitest', mocha: 'mocha', playwright: 'playwright', '@playwright/test': 'playwright', cypress: 'cypress',
  typescript: 'typescript', eslint: 'eslint', prettier: 'prettier', tailwindcss: 'tailwind', graphql: 'graphql', prisma: 'prisma', '@prisma/client': 'prisma', 'react-native': 'react-native', expo: 'expo',
};
const PY_FRAMEWORKS: Record<string, string> = {
  django: 'django', flask: 'flask', fastapi: 'fastapi', pytest: 'pytest', numpy: 'numpy', pandas: 'pandas', torch: 'pytorch', tensorflow: 'tensorflow', sqlalchemy: 'sqlalchemy', pydantic: 'pydantic', celery: 'celery', scikit_learn: 'scikit-learn',
};
const TEST_RUNNERS = ['vitest', 'jest', 'mocha', 'playwright', 'cypress', 'pytest'];

const TEST_FILE_RE = /(?:\.(?:test|spec)\.[a-z0-9]+$|_test\.(?:go|py|rs)$|^test_.*\.py$|Test\.java$)/;
const TEST_DIR_RE = /^(?:tests?|__tests__|spec|specs|e2e)$/;
const ENTRY_RE = /^(?:main|index|app|server|cli)\.[a-z0-9]+$|^__main__\.py$|^manage\.py$/;
const IMPORTANT_RE = /^(?:README|CONTRIBUTING|LICENSE|SECURITY|CHANGELOG|CODE_OF_CONDUCT)(?:\.[A-Za-z0-9]+)?$/i;
const ROOT_CONFIG = new Set(['tsconfig.json', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.env.example', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json']);
const CONVENTIONS = new Set(['CLAUDE.md', 'AGENTS.md']);
const CI_RE = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/config\.yml|azure-pipelines\.yml)$/;

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const depthOf = (p: string): number => p.split('/').length - 1;
const extOf = (name: string): string | null => {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return null;
  const e = name.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(e) ? e : null;
};
function addTo(map: Record<string, number>, k: string, n = 1): void {
  map[k] = (map[k] ?? 0) + n;
}
const topN = (m: Record<string, number>, n: number): string[] => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);

// ───────────────────────── manifest parsing (no execution; names only) ─────────────────────────

export interface ManifestFacts {
  frameworks: string[];
  scripts: ContextScript[];
  packageManagers: string[];
  entryPoints: string[];
  workspaces: string[];
}
const noFacts = (): ManifestFacts => ({ frameworks: [], scripts: [], packageManagers: [], entryPoints: [], workspaces: [] });

function parsePackageJson(text: string): ManifestFacts {
  const out = noFacts();
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = Object.hasOwn(j, field) && j[field] && typeof j[field] === 'object' ? j[field] : {};
    for (const name of Object.keys(deps)) if (Object.hasOwn(NODE_FRAMEWORKS, name)) out.frameworks.push(NODE_FRAMEWORKS[name]!);
  }
  const scripts = Object.hasOwn(j, 'scripts') && j.scripts && typeof j.scripts === 'object' && !Array.isArray(j.scripts) ? j.scripts : {};
  for (const name of Object.keys(scripts)) {
    if (typeof scripts[name] === 'string') out.scripts.push({ name, command: cleanCommand(scripts[name]) });
  }
  if (typeof j.packageManager === 'string') {
    const pm = j.packageManager.split('@')[0];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) out.packageManagers.push(pm);
  }
  if (typeof j.main === 'string') out.entryPoints.push(j.main.replace(/^\.\//, ''));
  if (typeof j.bin === 'string') out.entryPoints.push(j.bin.replace(/^\.\//, ''));
  else if (j.bin && typeof j.bin === 'object') for (const v of Object.values(j.bin)) if (typeof v === 'string') out.entryPoints.push(v.replace(/^\.\//, ''));
  const ws = Array.isArray(j.workspaces) ? j.workspaces : j.workspaces && Array.isArray(j.workspaces.packages) ? j.workspaces.packages : [];
  for (const w of ws) if (typeof w === 'string') out.workspaces.push(w);
  return out;
}

function parseLines(text: string, re: RegExp, max = 400): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').slice(0, 4000)) {
    const m = re.exec(line.trim());
    if (m?.[1]) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

function parseManifest(name: string, text: string): ManifestFacts {
  switch (name) {
    case 'package.json':
      return parsePackageJson(text);
    case 'requirements.txt': {
      const out = noFacts();
      for (const n of parseLines(text, /^([A-Za-z0-9_.-]+)/)) {
        const k = n.toLowerCase().replace(/-/g, '_');
        if (Object.hasOwn(PY_FRAMEWORKS, k)) out.frameworks.push(PY_FRAMEWORKS[k]!);
      }
      out.packageManagers.push('pip');
      return out;
    }
    case 'pyproject.toml': {
      const out = noFacts();
      for (const n of parseLines(text, /^"?([A-Za-z0-9_.-]+)"?\s*(?:[=<>~!,\]]|$)/)) {
        const k = n.toLowerCase().replace(/-/g, '_');
        if (Object.hasOwn(PY_FRAMEWORKS, k)) out.frameworks.push(PY_FRAMEWORKS[k]!);
      }
      if (/^\[tool\.poetry\]/m.test(text)) out.packageManagers.push('poetry');
      else if (/^\[tool\.uv\]/m.test(text)) out.packageManagers.push('uv');
      else out.packageManagers.push('pip');
      if (/^\[tool\.pytest/m.test(text)) out.frameworks.push('pytest');
      return out;
    }
    case 'Cargo.toml': {
      const out = noFacts();
      out.packageManagers.push('cargo');
      return out;
    }
    case 'go.mod': {
      const out = noFacts();
      out.packageManagers.push('go');
      return out;
    }
    case 'Gemfile': {
      const out = noFacts();
      out.packageManagers.push('bundler');
      return out;
    }
    case 'pom.xml': {
      const out = noFacts();
      out.packageManagers.push('maven');
      return out;
    }
    case 'build.gradle':
    case 'build.gradle.kts': {
      const out = noFacts();
      out.packageManagers.push('gradle');
      return out;
    }
    case 'Makefile': {
      const out = noFacts();
      for (const t of parseLines(text, /^([A-Za-z0-9_.-]+)\s*:(?!=)/, 30)) if (!t.startsWith('.')) out.scripts.push({ name: `make:${t}`, command: `make ${t}` });
      return out;
    }
    default:
      return noFacts();
  }
}

// ───────────────────────── a module (top-level directory) ─────────────────────────

export interface ModuleScan {
  /** Top-level directory name (identifier charset) — `null` entries are never produced. */
  path: string;
  treeSha: string;
  kind: ModuleKind;
  files: number;
  languages: Record<string, number>;
  entryPoints: string[];
  testFiles: number;
  testDirs: string[];
  children: { path: string; kind: ModuleKind; files: number; languages: string[]; entryPoints: string[] }[];
  frameworks: string[];
  scripts: ContextScript[];
  packageManagers: string[];
  ci: string[];
  important: string[];
  conventions: string[];
  symlinks: number;
  submodules: number;
  truncated: boolean;
  dropped: number;
}

function kindOfDir(name: string, hasManifest: boolean, langs: Record<string, number>): ModuleKind {
  const n = name.toLowerCase();
  if (TEST_DIR_RE.test(n)) return 'tests';
  if (/^(?:docs?|documentation|doc)$/.test(n)) return 'docs';
  if (/^(?:\.github|\.circleci|\.vscode|\.husky|config|configs|\.config|scripts|tools|ci)$/.test(n)) return 'config';
  if (/^apps?$/.test(n)) return 'app';
  if (hasManifest) return 'package';
  const docOnly = Object.keys(langs).length > 0 && Object.keys(langs).every((e) => ['md', 'mdx', 'rst', 'txt', 'adoc'].includes(e));
  if (docOnly) return 'docs';
  return 'lib';
}

/** Scan ONE top-level directory from its tree id (`name` is the directory name, already validated by the caller). */
export async function scanModule(src: GitSource, name: string, treeSha: string): Promise<ModuleScan> {
  const { entries, truncated } = await src.lsTreeRecursive(treeSha);
  const langs: Record<string, number> = {};
  let files = 0;
  let symlinks = 0;
  let submodules = 0;
  let testFiles = 0;
  let dropped = 0;
  const testDirs = new Set<string>();
  const entryPoints: string[] = [];
  const ci: string[] = [];
  const important: string[] = [];
  const conventions: string[] = [];
  const manifests: { rel: string; sha: string; size: number }[] = [];
  const ident = (p: string): string | null => (isIdent(p) ? p : (dropped++, null));
  if (TEST_DIR_RE.test(name)) testDirs.add(name); // the module itself is a test directory

  for (const e of entries) {
    if (e.mode === '120000') {
      symlinks++; // never followed, never read
      continue;
    }
    if (e.type === 'commit' || e.mode === '160000') {
      submodules++;
      continue;
    }
    if (e.type !== 'blob') continue;
    if (files >= FACT_LIMITS.maxFiles) {
      break;
    }
    files++;
    const rel = e.path;
    const b = base(rel);
    const ext = extOf(b);
    if (ext) addTo(langs, ext);
    if (TEST_FILE_RE.test(b)) testFiles++;
    const segs = rel.split('/');
    for (let i = 0; i < Math.min(segs.length - 1, 3); i++) {
      if (TEST_DIR_RE.test(segs[i]!)) {
        const dir = ident(`${name}/${segs.slice(0, i + 1).join('/')}`);
        if (dir) testDirs.add(dir);
      }
    }
    if (depthOf(rel) <= 2 && ENTRY_RE.test(b) && entryPoints.length < FACT_LIMITS.entryPoints * 2) {
      const p = ident(`${name}/${rel}`);
      if (p) entryPoints.push(p);
    }
    if (MANIFESTS.has(b) && depthOf(rel) <= 2 && e.size !== null && e.size <= SCAN_LIMITS.maxBlobBytes) manifests.push({ rel, sha: e.sha, size: e.size });
    if (CI_RE.test(`${name}/${rel}`) || CI_RE.test(rel)) {
      const p = ident(`${name}/${rel}`);
      if (p && ci.length < FACT_LIMITS.ci) ci.push(p);
    }
    if (depthOf(rel) === 0 && IMPORTANT_RE.test(b)) {
      const p = ident(`${name}/${rel}`);
      if (p) important.push(p);
    }
    if (depthOf(rel) <= 1 && CONVENTIONS.has(b)) {
      const p = ident(`${name}/${rel}`);
      if (p) conventions.push(p);
    }
  }

  // manifests: shallowest first, a bounded number, one cat-file process
  manifests.sort((a, b) => depthOf(a.rel) - depthOf(b.rel) || a.rel.localeCompare(b.rel));
  const chosen = manifests.slice(0, SCAN_LIMITS.maxBlobsPerModule);
  dropped += manifests.length - chosen.length;
  const blobs = chosen.length ? await src.catBlobs(chosen.map((m) => m.sha), SCAN_LIMITS.maxBlobBytes) : new Map<string, string | null>();

  const frameworks = new Set<string>();
  const scripts: ContextScript[] = [];
  const packageManagers = new Set<string>();
  const childDirs = new Map<string, { hasManifest: boolean; entry: string[] }>();
  let ownManifest = false;
  for (const m of chosen) {
    const text = blobs.get(m.sha);
    const dir = m.rel.includes('/') ? m.rel.slice(0, m.rel.lastIndexOf('/')) : '';
    if (text === null || text === undefined) continue;
    const mf = parseManifest(base(m.rel), text);
    for (const f of mf.frameworks) frameworks.add(f);
    for (const p of mf.packageManagers) packageManagers.add(p);
    if (dir === '') {
      ownManifest = true;
      for (const s of mf.scripts) scripts.push(s);
      for (const ep of mf.entryPoints) {
        const p = `${name}/${ep}`;
        if (isIdent(p) && entryPoints.length < FACT_LIMITS.entryPoints * 2) entryPoints.push(p);
      }
    } else if (depthOf(dir) <= 1 && ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts'].includes(base(m.rel))) {
      const cur = childDirs.get(dir) ?? { hasManifest: true, entry: [] };
      childDirs.set(dir, cur);
    }
  }

  // workspace packages: a manifest one or two levels down is a package of its own
  const children: ModuleScan['children'] = [];
  for (const dir of [...childDirs.keys()].sort()) {
    if (children.length >= SCAN_LIMITS.maxChildren) {
      dropped++;
      continue;
    }
    const path = ident(`${name}/${dir}`);
    if (!path) continue;
    const prefix = `${dir}/`;
    const sub = entries.filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path.startsWith(prefix));
    const subLangs: Record<string, number> = {};
    const subEntry: string[] = [];
    for (const e of sub) {
      const ext = extOf(base(e.path));
      if (ext) addTo(subLangs, ext);
      if (depthOf(e.path.slice(prefix.length)) <= 1 && ENTRY_RE.test(base(e.path)) && subEntry.length < FACT_LIMITS.entryPoints) {
        const p = ident(`${name}/${e.path}`);
        if (p) subEntry.push(p);
      }
    }
    children.push({ path, kind: 'package', files: sub.length, languages: topN(subLangs, FACT_LIMITS.moduleLanguages), entryPoints: subEntry });
  }

  return {
    path: name,
    treeSha,
    kind: kindOfDir(name, ownManifest, langs),
    files,
    languages: langs,
    entryPoints: entryPoints.slice(0, FACT_LIMITS.entryPoints),
    testFiles,
    testDirs: [...testDirs].sort(),
    children,
    frameworks: [...frameworks].sort(),
    scripts,
    packageManagers: [...packageManagers].sort(),
    ci,
    important,
    conventions,
    symlinks,
    submodules,
    truncated: truncated || files >= FACT_LIMITS.maxFiles,
    dropped,
  };
}

// ───────────────────────── the repository root ─────────────────────────

export interface RootScan {
  files: number;
  languages: Record<string, number>;
  frameworks: string[];
  scripts: ContextScript[];
  packageManagers: string[];
  important: string[];
  conventions: string[];
  ci: string[];
  testFiles: number;
  symlinks: number;
  submodules: number;
  /** blob id per root manifest — what incremental refresh compares. */
  rootBlobs: Record<string, string>;
  dropped: number;
}

/**
 * The root's own (non-recursive) listing: file counts, extensions, important files, and the manifests' contents. `reuse` carries the
 * parsed manifest facts of blobs whose id did not change since the last refresh, so only changed manifests are read.
 */
export async function scanRoot(src: GitSource, rootEntries: TreeEntry[], reuse?: { rootBlobs: Record<string, string>; parsed: Record<string, ManifestFacts> }): Promise<{ root: RootScan; parsed: Record<string, ManifestFacts> }> {
  const langs: Record<string, number> = {};
  let files = 0;
  let symlinks = 0;
  let submodules = 0;
  let testFiles = 0;
  let dropped = 0;
  const important: string[] = [];
  const conventions: string[] = [];
  const ci: string[] = [];
  const rootBlobs: Record<string, string> = {};
  const wantRead: TreeEntry[] = [];
  for (const e of rootEntries) {
    if (e.mode === '120000') {
      symlinks++;
      continue;
    }
    if (e.type === 'commit' || e.mode === '160000') {
      submodules++;
      continue;
    }
    if (e.type !== 'blob') continue;
    files++;
    const ext = extOf(e.path);
    if (ext) addTo(langs, ext);
    if (TEST_FILE_RE.test(e.path)) testFiles++;
    const keep = (list: string[]): void => {
      if (isIdent(e.path)) list.push(e.path);
      else dropped++;
    };
    if (IMPORTANT_RE.test(e.path) || ROOT_CONFIG.has(e.path)) keep(important);
    if (CONVENTIONS.has(e.path)) keep(conventions);
    if (CI_RE.test(e.path)) keep(ci);
    if (MANIFESTS.has(e.path)) {
      rootBlobs[e.path] = e.sha;
      if (!(reuse && reuse.rootBlobs[e.path] === e.sha && reuse.parsed[e.path])) {
        if (e.size !== null && e.size <= SCAN_LIMITS.maxBlobBytes) wantRead.push(e);
        else dropped++;
      }
    }
  }
  const blobs = wantRead.length ? await src.catBlobs(wantRead.map((e) => e.sha), SCAN_LIMITS.maxBlobBytes) : new Map<string, string | null>();
  const parsed: Record<string, ManifestFacts> = {};
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const scripts: ContextScript[] = [];
  for (const [name, sha] of Object.entries(rootBlobs)) {
    let mf: ManifestFacts | undefined;
    if (reuse && reuse.rootBlobs[name] === sha && reuse.parsed[name]) mf = reuse.parsed[name];
    else {
      const text = blobs.get(sha);
      mf = typeof text === 'string' ? parseManifest(name, text) : noFacts();
    }
    parsed[name] = mf!;
    for (const f of mf!.frameworks) frameworks.add(f);
    for (const p of mf!.packageManagers) packageManagers.add(p);
    for (const s of mf!.scripts) scripts.push(s);
  }
  // package managers from lockfiles at the root
  const names = new Set(rootEntries.filter((e) => e.type === 'blob').map((e) => e.path));
  if (names.has('pnpm-lock.yaml')) packageManagers.add('pnpm');
  if (names.has('yarn.lock')) packageManagers.add('yarn');
  if (names.has('bun.lock') || names.has('bun.lockb')) packageManagers.add('bun');
  if (names.has('package-lock.json')) packageManagers.add('npm');
  return {
    root: { files, languages: langs, frameworks: [...frameworks].sort(), scripts, packageManagers: [...packageManagers].sort(), important, conventions, ci, testFiles, symlinks, submodules, rootBlobs, dropped },
    parsed,
  };
}

// ───────────────────────── assembly ─────────────────────────

export function assembleFacts(root: RootScan, mods: ModuleScan[], extra: { gates: GateDef[]; moduleOverflow: number }): ContextFacts {
  const langs: Record<string, number> = { ...root.languages };
  const frameworks = new Set(root.frameworks);
  const packageManagers = new Set(root.packageManagers);
  const scripts: ContextScript[] = [...root.scripts];
  const important = [...root.important];
  const conventions = [...root.conventions];
  const ci = [...root.ci];
  const testDirs = new Set<string>();
  let files = root.files;
  let testFiles = root.testFiles;
  let symlinks = root.symlinks;
  let submodules = root.submodules;
  let truncated = false;
  let dropped = root.dropped;
  const modules: ContextModule[] = [];
  for (const m of [...mods].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const [k, v] of Object.entries(m.languages)) addTo(langs, k, v);
    for (const f of m.frameworks) frameworks.add(f);
    for (const p of m.packageManagers) packageManagers.add(p);
    // a module's own scripts are namespaced; the root's stay bare
    for (const s of m.scripts) scripts.push({ name: `${m.path}:${s.name}`, command: s.command });
    important.push(...m.important);
    conventions.push(...m.conventions);
    ci.push(...m.ci);
    for (const d of m.testDirs) testDirs.add(d);
    files += m.files;
    testFiles += m.testFiles;
    symlinks += m.symlinks;
    submodules += m.submodules;
    truncated ||= m.truncated;
    dropped += m.dropped;
    modules.push({ path: m.path, kind: m.kind, files: m.files, languages: topN(m.languages, FACT_LIMITS.moduleLanguages), entryPoints: m.entryPoints });
    for (const c of m.children) modules.push({ path: c.path, kind: c.kind, files: c.files, languages: c.languages, entryPoints: c.entryPoints });
  }
  const fw = [...frameworks].sort();
  const runner = TEST_RUNNERS.find((r) => fw.includes(r)) ?? (langs.go ? 'go-test' : langs.rs ? 'cargo-test' : null);
  const raw = {
    languages: langs,
    packageManagers: [...packageManagers].sort(),
    frameworks: fw,
    scripts,
    gates: extra.gates.map((g) => ({ name: g.name, kind: g.kind, cmd: g.cmd })),
    modules,
    tests: { runner, dirs: [...testDirs].sort(), fileCount: testFiles },
    importantFiles: important,
    ci,
    conventionsFiles: conventions,
    counts: { files, symlinks, submodules, truncated: truncated || files > FACT_LIMITS.maxFiles, dropped, moduleOverflow: extra.moduleOverflow },
  };
  return normalizeFacts(raw).facts;
}
