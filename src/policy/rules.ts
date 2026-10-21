// Static risk rules (M6): evaluated on STRUCTURED plan fields only — `testing.commands[]`, `filesToChange[]` (paths, actions) and task-graph
// item files/verification — plus backticked or fenced CODE inside prose `steps` (Security C6-1). Free prose is never inspected: a step that
// says "update the deployment docs" must not hold a plan. The list is code, not config. Conductor cannot intercept a `--force` builder's own
// shell calls; these rules are a safety net for what a PLAN says it will run, not a guarantee.
import type { Plan } from '../types.ts';

export interface RiskHit { rule: string; detail: string }

/** Exported for display flags (M8-6 S10). */
export const SECRET_FILE = /(^|\/)\.env(\.|$)|(^|\/)(id_rsa|id_ed25519|credentials|secrets?\.(json|ya?ml|toml))$|\.(pem|key|p12|pfx|keystore)$/i;
/** What a regex sees: NFKC (fullwidth etc.), format/invisible characters removed, lower-case, whitespace collapsed, quotes inside words dropped. */
export function canon(s: string): string {
  return String(s).normalize('NFKC').replace(/[\p{Cf}\p{Co}\p{Cn}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}]/gu, '').replace(/(?<=\w)["'](?=\w)/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const OPTS = String.raw`(?:\s+-{1,2}[a-z0-9-]+(?:[ =][^\s-][^\s]*)?)*`; // options (and their value) between a tool and its sub-command
// destructive / production commands (matched on canon() text)
const DESTRUCTIVE: [string, RegExp][] = [
  ['recursive delete', /\brm\s+(?:-\S+\s+)*(?:-[a-z]*r[a-z]*|--recursive)\b/],
  ['git push', new RegExp(String.raw`\bgit${OPTS}\s+push\b`)],
  ['git reset --hard', new RegExp(String.raw`\bgit${OPTS}\s+reset\b[^;&|\n]*--hard\b`)],
  ['git clean', new RegExp(String.raw`\bgit${OPTS}\s+clean\s+-[a-z]*f`)],
  ['drop/truncate', /\b(?:drop\s+(?:table|database|schema|index)|truncate\s+(?:table\s+)?[a-z_"`]+)/],
  ['terraform apply/destroy', new RegExp(String.raw`\bterraform${OPTS}\s+(?:apply|destroy)\b`)],
  ['kubectl apply/delete', new RegExp(String.raw`\bkubectl${OPTS}\s+(?:apply|delete)\b`)],
  ['docker push', new RegExp(String.raw`\bdocker${OPTS}\s+(?:image\s+)?push\b`)],
  ['package publish', new RegExp(String.raw`\b(?:npm|pnpm|yarn)${OPTS}\s+publish\b|\btwine\s+upload\b|\bpip\s+upload\b`)],
  ['pipe to shell', /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|perl|ruby)\b|\b(?:sh|bash|zsh)\s*<\(\s*(?:curl|wget)\b/],
  ['aws delete', /\baws\b[^\n]*\b(?:delete|rm|terminate)[a-z-]*\b/],
];
/** Deploy/CI definitions (one constant list, matched on the normalised path). */
const DEPLOY_FILE = /(^|\/)(Dockerfile(\..+)?|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|Chart\.yaml|serverless\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|Procfile|app\.yaml|cloudbuild\.ya?ml|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml)$|\.(tf|tfvars)$|(^|\/)(helm|k8s|kubernetes)\/|^\.github\/workflows\//;
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Commands found in a prose step: only what is inside `backticks` or a ``` fence. */
export function codeSpans(text: string): string[] {
  const out: string[] = [];
  const fence = /(?:```|~~~)[^\n]*\n?([\s\S]*?)(?:```|~~~|$)/g; // an unclosed fence runs to the end of the step
  for (const m of text.matchAll(fence)) out.push(m[1]!);
  for (const m of text.replace(fence, ' ').matchAll(/`([^`\n]+)`/g)) out.push(m[1]!);
  return out;
}

export function riskHits(plan: Plan): RiskHit[] {
  const hits: RiskHit[] = [];
  const add = (rule: string, detail: string): void => void (hits.some((h) => h.rule === rule && h.detail === detail) || hits.push({ rule, detail: detail.slice(0, 160) }));
  const files = plan.filesToChange.map((f) => ({ path: norm(f.path), action: f.action }));
  const itemFiles = (plan.taskGraph?.items ?? []).flatMap((i) => (Array.isArray(i.files) ? i.files : [])).map(norm);
  const allPaths = [...new Set([...files.map((f) => f.path), ...itemFiles])];
  for (const p of allPaths) {
    if (SECRET_FILE.test(p)) add('secret-looking file', p);
    if (DEPLOY_FILE.test(p)) add('CI/deploy definition', p);
  }
  const changed = files.filter((f) => f.action === 'delete' || (f.action as string) === 'rename');
  if (changed.length > 5) add('many deletes/renames', `${changed.length} files deleted or renamed`);
  if (allPaths.length > 25) add('many files', `${allPaths.length} files`);
  const commands = [
    ...(plan.testing?.commands ?? []),
    ...(plan.taskGraph?.items ?? []).flatMap((i) => (Array.isArray(i.verification) ? i.verification : [])),
    ...(plan.steps ?? []).flatMap((s) => codeSpans(String(s))),
  ];
  for (const c of commands) {
    const text = canon(String(c));
    for (const [name, re] of DESTRUCTIVE) if (re.test(text)) add(name, String(c));
  }
  return hits;
}
