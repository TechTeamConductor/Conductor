/** Provider-agnostic structured-output helpers: tolerant JSON extraction + a tiny JSON-Schema validator. */

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Last parseable balanced `{…}` object in the text (string/escape aware). */
function lastBalancedObject(textIn: string): string | null {
  // bound the work: only the last 300 KB, and at most 500 candidate starts (a hostile "{{{{…" must not be quadratic)
  const text = textIn.length > 300_000 ? textIn.slice(-300_000) : textIn;
  let last: string | null = null;
  let i = 0;
  let starts = 0;
  while (i < text.length && starts++ < 500) {
    const start = text.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > 0) {
      const cand = text.slice(start, end + 1);
      if (tryParse(cand) !== undefined) {
        last = cand;
        i = end + 1;
        continue;
      }
    }
    i = start + 1;
  }
  return last;
}

/**
 * Extract one JSON value from model text: whole text → last ```json fence → last balanced object.
 * Tolerates leading/trailing prose (observed on real Cursor ask-mode output).
 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;
  const isObj = (v: unknown): v is object => v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v);
  const whole = tryParse(text.trim());
  if (isObj(whole)) return whole;
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const v = tryParse((fences[i]![1] ?? '').trim());
    if (isObj(v)) return v;
  }
  const obj = lastBalancedObject(text);
  if (obj) return tryParse(obj) ?? null;
  return null;
}

export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  additionalProperties?: boolean | Schema;
  description?: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Returns a list of human-readable violations (empty = valid). Supports the subset our schemas use. */
export function validateSchema(schema: Schema, value: unknown, path = '$'): string[] {
  const errs: string[] = [];
  const t = typeOf(value);
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((a) => a === t || (a === 'number' && t === 'integer'));
    if (!ok) return [`${path}: expected ${allowed.join('|')}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value as never)) errs.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (t === 'string' && schema.minLength !== undefined && (value as string).length < schema.minLength) errs.push(`${path}: too short`);
  if (t === 'object' && value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) errs.push(`${path}.${r}: required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in o) errs.push(...validateSchema(sub, o[k], `${path}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(o)) if (!(k in (schema.properties ?? {}))) errs.push(`${path}.${k}: unexpected property`);
    }
  }
  if (t === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items!, v, `${path}[${i}]`)));
  }
  return errs;
}

/** One-line-per-field description of a schema for prompts ("fill this shape"). */
export function describeSchema(schema: Schema, indent = 0): string {
  const pad = '  '.repeat(indent);
  const t = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
  if (t === 'object' && schema.properties) {
    const req = new Set(schema.required ?? []);
    return Object.entries(schema.properties)
      .map(([k, v]) => {
        const vt = Array.isArray(v.type) ? v.type.join('|') : v.type;
        const head = `${pad}- ${k}${req.has(k) ? '' : '?'}: ${vt === 'object' || vt === 'array' ? vt : vt ?? 'any'}${v.enum ? ` (one of ${v.enum.join(' | ')})` : ''}${v.description ? ` — ${v.description}` : ''}`;
        if (vt === 'object') return `${head}\n${describeSchema(v, indent + 1)}`;
        if (vt === 'array' && v.items) {
          const it = v.items;
          const itT = Array.isArray(it.type) ? it.type.join('|') : it.type;
          return itT === 'object' ? `${head} of objects:\n${describeSchema(it, indent + 1)}` : `${head} of ${itT ?? 'any'}`;
        }
        return head;
      })
      .join('\n');
  }
  return `${pad}${t ?? 'any'}`;
}
