// Static risk rules (M6): evaluated on STRUCTURED plan fields only — `testing.commands[]`, `filesToChange[]` (paths, actions) and task-graph
// item files/verification — plus backticked or fenced CODE inside prose `steps` (Security C6-1). Free prose is never inspected: a step that
// says "update the deployment docs" must not hold a plan. The list is code, not config. Conductor cannot intercept a `--force` builder's own
// shell calls; these rules are a safety net for what a PLAN says it will run, not a guarantee.
import type { Plan } from '../types.ts';

export interface RiskHit { rule: string; detail: string }

const SECRET_FILE = /(^|\/)\.env(\.|$)|(^|\/)(id_rsa|id_ed25519|credentials|secrets?\.(json|ya?ml|toml))$|\.(pem|key|p12|pfx|keystore)$/i;
// destructive / production commands
const DESTRUCTIVE: [string, RegExp][] = [
  ['recursive delete', /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\b/],
  ['git push', /\bgit\s+push\b/],
  ['git reset --hard', /\bgit\s+reset\s+--hard\b/],
  ['drop/truncate', /\b(drop|truncate)\s+(table|database|schema)\b/i],
  ['terraform apply/destroy', /\bterraform\s+(apply|destroy)\b/],
  ['kubectl apply/delete', /\bkubectl\s+(apply|delete)\b/],
  ['docker push', /\bdocker\s+push\b/],
  ['package publish', /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bpip\s+upload\b/],
  ['pipe to shell', /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/],
  ['aws delete', /\baws\b[^\n]*\b(delete|rm|terminate)[a-z-]*\b/],
];
/** Deploy/CI definitions (one constant list, matched on the normalised path). */
const DEPLOY_FILE = /(^|\/)(Dockerfile(\..+)?|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|Chart\.yaml|serverless\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|Procfile|app\.yaml|cloudbuild\.ya?ml|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml)$|\.(tf|tfvars)$|(^|\/)(helm|k8s|kubernetes)\/|^\.github\/workflows\//;
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Commands found in a prose step: only what is inside `backticks` or a ``` fence. */
export function codeSpans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n?([\s\S]*?)```/g)) out.push(m[1]!);
  for (const m of text.replace(/```[\s\S]*?```/g, ' ').matchAll(/`([^`\n]+)`/g)) out.push(m[1]!);
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
  for (const c of commands) for (const [name, re] of DESTRUCTIVE) if (re.test(String(c))) add(name, String(c));
  return hits;
}
