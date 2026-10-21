// Static safety checks for the dashboard (M8-U, AC6). Zero exceptions: model and CLI text reach the page only as text nodes, through
// the DOM-only markdown renderer, or through h(), whose attribute writes go through ConductorModes.safeAttr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dirname, '..', 'ui');
const jsFiles = readdirSync(UI).filter((f) => f.endsWith('.js'));
const read = (f: string): string => readFileSync(join(UI, f), 'utf8');
/** Source without comments, so that a word in a comment neither hides nor fakes a finding. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

const BANNED: [string, RegExp][] = [
  ['innerHTML', /innerHTML/i], ['outerHTML', /outerHTML/i], ['insertAdjacentHTML', /insertAdjacentHTML/i], ['document.write', /document\.write/],
  ['eval(', /\beval\s*\(/], ['new Function', /new\s+Function\b/], ['Function(', /\bFunction\s*\(/],
  ["setAttribute('on…')", /setAttribute\(\s*['"`]on/i], ["setAttribute('style')", /setAttribute\(\s*['"`]style/i],
  ['style: key passed to h()', /[{,]\s*['"]?style['"]?\s*:/], ['.cssText', /\.cssText\b/], ['srcdoc', /srcdoc/i],
  ['DOMParser', /DOMParser/], ['createContextualFragment', /createContextualFragment/], ['javascript: URL', /javascript:/i],
  ['setTimeout with a string', /set(Timeout|Interval)\(\s*['"`]/],
];
/** Banned patterns found in the RAW source: no comment stripping, so a string like 'a // b' can never hide what follows it. */
function sinksIn(src: string, file: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of BANNED) {
    // modes.js's safeAttr names the attributes it drops (lower-case 'srcdoc', 'innerhtml', 'outerhtml') and tests nothing else
    if (file === 'modes.js' && ['srcdoc', 'innerHTML', 'outerHTML'].includes(name)) {
      const rest = src.replace(/const DROP_ATTR = new Set\(\[[^\]]*\]\);/, '');
      if (re.test(rest)) hits.push(name);
      continue;
    }
    if (re.test(src)) hits.push(name);
  }
  return hits;
}

test('ui/*.js has no HTML sink, no string evaluation and no style or handler injection (raw source, zero exceptions)', () => {
  assert.ok(jsFiles.includes('app.js') && jsFiles.includes('modes.js'));
  for (const f of jsFiles) assert.deepEqual(sinksIn(read(f), f), [], `${f}`);
});

test('the sink scan cannot be fooled by a "//" inside a string or by a comment', () => {
  assert.deepEqual(sinksIn("const x = 'a // b'; el.innerHTML = y;", 'app.js'), ['innerHTML']);
  assert.deepEqual(sinksIn('/* harmless */ const s = "http://x"; eval(s)', 'app.js'), ['eval(']);
  assert.deepEqual(sinksIn("// el.outerHTML = x", 'app.js'), ['outerHTML'], 'even a comment counts: the raw scan has no blind spots');
  assert.deepEqual(sinksIn("const DROP_ATTR = new Set(['srcdoc', 'innerhtml']); n.innerHTML = 1;", 'modes.js'), ['innerHTML'], "modes.js's exemption covers only its drop list");
});

test('every URL-bearing attribute write in ui/*.js is on the reviewed allow-list', () => {
  // Each occurrence must contain one of these reviewed snippets. A new one fails here until it is reviewed and added.
  const allowed: Record<string, string[]> = {
    'app.js': [
      "use.setAttribute('href', '#i-' + name)", // sprite icons: constant names only
      "h('a', { href, target: '_blank', rel: 'noopener noreferrer' }", // toast link and markdown links: safeHttp() first
      "href: '#/'", "href: '#/board'", "href: '#/setup'", // in-app routes
      "href: b.action.href", // banner actions: built from the in-app routes above
      "href: '#/run/' + enc(", // run links: key always encoded
    ],
    'modes.js': ["const DROP_ATTR = new Set([", "const URL_ATTR = new Set(["], // safeAttr's own name lists
  };
  const patterns = [
    /\bsetAttribute\(\s*['"`](href|src|action|formaction|srcset|xlink:href|poster)\b/gi,
    /[{,]\s*['"]?(href|src|action|formaction|srcset|poster)['"]?\s*[:,}]/g,
    /\.(href|src|action|formAction|srcset|poster)\s*=(?!=)/g,
  ];
  for (const f of jsFiles) {
    const lines = code(read(f)).split('\n');
    lines.forEach((line, i) => {
      for (const re of patterns) {
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        // a data object's own `action:` key (banner actions) is not an attribute; its href is checked on its own line
        if (/\baction:\s*\{\s*label:/.test(line) && !/\bhref:\s*(?!'#\/)/.test(line)) continue;
        assert.ok((allowed[f] ?? []).some((s) => line.includes(s)), `${f}:${i + 1} writes a URL attribute that is not on the allow-list:\n${line.trim()}`);
      }
    });
  }
});

test('ui/index.html: no inline script, style or handler; modes.js loads before app.js', () => {
  const html = readFileSync(join(UI, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1]!, /\bsrc="\/[a-z]+\.js"/, 'external scripts only');
    assert.equal(m[2]!.trim(), '', 'no inline script body');
  }
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline handler');
  assert.doesNotMatch(html, /javascript:/i);
  const a = html.indexOf('<script src="/modes.js" defer></script>');
  const b = html.indexOf('<script src="/app.js" defer></script>');
  assert.ok(a > 0 && b > a, 'modes.js first, both deferred');
});

test('ui/style.css: no @import and no external url()', () => {
  const css = readFileSync(join(UI, 'style.css'), 'utf8');
  assert.doesNotMatch(css, /@import/i);
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]*)/gi)) assert.match(m[1]!, /^(#|data:image\/)/, `external url(${m[1]})`);
});

test('no code for controls whose backend is not built yet (M8-U §2.0; each slice removes its own entry)', () => {
  const app = code(read('app.js'));
  for (const id of ['runMode', '/api/run-mode', '/api/models', '/api/accounts']) {
    assert.ok(!app.includes(id), `ui/app.js mentions ${id}`);
  }
});
