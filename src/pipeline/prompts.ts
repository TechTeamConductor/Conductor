import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Plan } from '../types.ts';
import { truncate } from '../util.ts';

const PROMPT_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));
const cache = new Map<string, string>();

function load(name: string): string {
  let t = cache.get(name);
  if (t === undefined) {
    t = readFileSync(join(PROMPT_DIR, name), 'utf8');
    cache.set(name, t);
  }
  return t;
}

export type Vars = Record<string, string | undefined | null>;

/**
 * Tiny template engine: `{{var}}` and `{{#var}}…{{/var}}` (block rendered only when var is non-empty).
 * Values are inserted verbatim — callers must fence untrusted text with `fence()` first.
 */
export function render(template: string, vars: Vars): string {
  let out = template.replace(/\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g, (_m, k: string, body: string) => (vars[k] ? body : ''));
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => (vars[k] ?? ''));
  return out.replace(/\n{4,}/g, '\n\n\n');
}

export const STAGE_LABEL: Record<string, string> = {
  plan: 'plan',
  plan_review: 'plan review',
  build: 'build',
  fix: 'fix',
  verify: 'verify',
  design: 'design the work',
  research_brief: 'research brief',
};

export function preamble(stage: string): string {
  return render(load('_preamble.md'), { stageLabel: STAGE_LABEL[stage] ?? stage });
}

/** Wrap untrusted text so it cannot terminate its own fence. */
export function fence(source: string, text: string, max = 24_000): string {
  const safe = truncate(String(text ?? ''), max).replace(/<\/untrusted/gi, '<\\/untrusted').replace(/<untrusted/gi, '<\\untrusted');
  return `<untrusted source="${source.replace(/[^\w.:/ -]/g, '')}">\n${safe}\n</untrusted>`;
}

export function taskBlock(args: { key: string; title: string; description: string; comments?: string[] }): string {
  const parts = [`Issue key: ${args.key}`, `Title: ${args.title}`, '', 'Description:', args.description || '(none)'];
  if (args.comments?.length) parts.push('', 'Clarifications from the requester (oldest first):', ...args.comments.map((c, i) => `${i + 1}. ${c}`));
  return fence('task-card', parts.join('\n'));
}

export function conventionsBlock(files: { name: string; text: string }[]): string {
  if (!files.length) return '';
  return files.map((f) => fence(`repo-file:${f.name}`, f.text, 16_000)).join('\n\n');
}

import { isGraphPlan, itemsOf, sanitizeLine } from './graph.ts';

export function planToMarkdown(p: Plan): string {
  const L: string[] = [];
  L.push(`### Summary`, p.summary, '');
  if (p.assumptions.length) L.push('### Assumptions', ...p.assumptions.map((a) => `- ${a}`), '');
  L.push('### Current state', p.currentState, '', '### Expected state', p.expectedState, '');
  L.push('### Acceptance criteria', ...p.acceptanceCriteria.map((a) => `- **${a.id}** ${a.text}\n  - *Verify:* ${a.verification}`), '');
  if (p.filesToChange.length) {
    L.push('### Files to change', '| File | Action | Change | Reason |', '| --- | --- | --- | --- |');
    for (const f of p.filesToChange) L.push(`| \`${f.path}\` | ${f.action} | ${esc(f.change)} | ${esc(f.reason)} |`);
    L.push('');
  }
  if (isGraphPlan(p)) {
    // the decomposition is part of what a human approves: items, order, files and the criteria each one owns
    L.push('### Tasks', '| Id | Role | Task | Depends on | Files | Criteria |', '| --- | --- | --- | --- | --- | --- |');
    for (const it of itemsOf(p)) L.push(`| ${esc(it.id)} | ${esc(it.role)} | ${esc(sanitizeLine(it.title, 160))} — ${esc(sanitizeLine(it.objective, 2000))} | ${esc(it.dependsOn.join(', ') || '—')} | ${esc(it.files.map((f) => `\`${f}\``).join(', ') || '—')} | ${esc(it.criteria.join(', ') || '—')} |`);
    L.push('');
    // everything a builder is told about a task is shown here in full: the objective above and the checks below
    for (const it of itemsOf(p)) if (it.verification.length) L.push(`**${esc(it.id)} checks:** ${it.verification.map((v) => esc(sanitizeLine(v, 300))).join(' · ')}`);
    L.push('');
  }
  if (p.steps.length) L.push('### Steps', ...p.steps.map((s, i) => `${i + 1}. ${s}`), '');
  L.push('### Testing', ...(p.testing.commands.length ? ['Commands:', ...p.testing.commands.map((c) => `- \`${c}\``)] : []), ...(p.testing.cases.length ? ['Cases:', ...p.testing.cases.map((c) => `- ${c}`)] : []), '');
  if (p.risks.length) L.push('### Risks', ...p.risks.map((r) => `- ${r}`), '');
  if (p.coverage.length) {
    L.push('### Requirement coverage', '| Requirement | Change | Verification |', '| --- | --- | --- |');
    for (const c of p.coverage) L.push(`| ${esc(c.requirement)} | ${esc(c.change)} | ${esc(c.verification)} |`);
    L.push('');
  }
  L.push(`*Complexity: ${p.complexity}*`);
  return L.join('\n');
}
const esc = (s: string) => String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

export function loadTemplate(name: 'plan' | 'plan-review' | 'build' | 'build-item' | 'item-analysis' | 'fix' | 'verify' | 'ask' | 'research' | 'design-work' | 'research-brief'): string {
  return load(`${name}.md`);
}
