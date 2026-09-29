#!/usr/bin/env node
/**
 * Realm AI — project self-check.
 *
 * Catches the mistakes that make a Cloudflare deployment look "broken" long before
 * you open the browser: a missing index.html, an /api/* route with no function file,
 * a `<script src>` pointing at a moved file, a pasted provider key committed by accident.
 *
 *   node scripts/check.mjs          errors -> exit 1 (CI fails)
 *                                   warnings -> annotations, exit 0 (things to finish)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

const read = (p) => {
  try {
    return fs.readFileSync(path.join(root, p), 'utf8');
  } catch {
    errors.push(`missing required file: ${p}`);
    return '';
  }
};
const exists = (p) => fs.existsSync(path.join(root, p));

/* ----------------------------------------------------------- structure */

const required = [
  'public/index.html',
  'public/tiers.js',
  'public/pricing.js',
  'public/welcome.html',
  'public/_headers',
  'public/robots.txt',
  'public/sitemap.xml',
  'public/404.html',
  'shared/api.js',
  'worker/index.js',
  'wrangler.json',
  'functions/api/chat.js',
  'functions/api/health.js',
  'functions/api/paddle-config.js',
  'functions/api/paddle/webhook.js',
  'supabase/schema.sql'
];
for (const f of required) if (!exists(f)) errors.push(`missing file: ${f}`);

// Cloudflare Pages: the site root is 404 unless an index.html exists in the output dir.
if (fs.existsSync(path.join(root, 'index (2).html')) || fs.existsSync(path.join(root, 'index (1).html'))) {
  errors.push('a browser-download filename like "index (2).html" is at the repo root — rename it to public/index.html or the site root will 404');
}
if (exists('index.html') && !exists('public/index.html')) {
  warnings.push('index.html is at the repo root; keep it in public/ and set the Pages output directory to public');
}

// Any *.html with a space or parenthesis in the name is never served as /.
for (const dir of ['public', '.']) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const entry of fs.readdirSync(abs)) {
    if (/\.html?$/i.test(entry) && /[( ]/.test(entry)) errors.push(`${rel(path.join(dir, entry))}: rename it — Cloudflare serves it under that exact URL, never as /`);
  }
}

/* ------------------------------------------------------------ wrangler */

let wrangler = {};
try {
  wrangler = JSON.parse(read('wrangler.json'));
} catch (e) {
  errors.push(`wrangler.json is not valid JSON: ${e.message}`);
}
const assetsDir = String(wrangler?.assets?.directory || '').replace(/^\.\//, '');
if (!assetsDir) errors.push('wrangler.json must set assets.directory (expected "./public")');
if (wrangler?.main && !exists(wrangler.main)) errors.push(`wrangler.json main points at ${wrangler.main}, which does not exist`);
if (assetsDir && exists(assetsDir) && !exists(path.join(assetsDir, 'index.html'))) errors.push(`${assetsDir}/index.html is missing, so the site root will 404`);

/* --------------------------------------------------- asset references */

const html = read('public/index.html');
for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) {
  const target = m[1].replace(/\/$/, '');
  if (target.startsWith('//') || target.startsWith('/api/')) continue;
  const candidates = [target, `${target}.html`, path.join('public', target)].map((c) => c.replace(/^\/+/, ''));
  if (!candidates.some((c) => exists(c))) errors.push(`index.html references ${m[1]} which is not in public/ (404 after deploy)`);
}
// pricing.js reads window.REALM_TIERS, so tiers.js has to come first.
{
  const t = html.indexOf('src="/tiers.js"');
  const p = html.indexOf('src="/pricing.js"');
  if (p > -1 && (t === -1 || t > p)) errors.push('index.html must load /tiers.js before /pricing.js');
}
if (/api\.openai\.com|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+ey[A-Za-z0-9_-]{10,}/.test(html)) {
  errors.push('index.html appears to contain a provider key or JWT. Keys belong in Cloudflare secrets, never in the page.');
}

/* -------------------------------------------------- inline JS syntax */

const checkJs = (file, source) => {
  const tmp = path.join(root, '.check.tmp.mjs');
  fs.writeFileSync(tmp, source);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`${file}: syntax error — ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' ').slice(0, 300)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
};

for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
  if (m[1].trim()) checkJs('public/index.html (inline script)', m[1]);
}

const jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.wrangler', 'dist'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) jsFiles.push(abs);
  }
})(root);
for (const f of jsFiles) checkJs(rel(f), fs.readFileSync(f, 'utf8'));

// Relative imports must resolve — the classic Pages "Build failed with 1 error" (wrong ../.. depth).
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`) && !fs.existsSync(path.join(target, 'index.js'))) {
      errors.push(`${rel(f)}: import "${m[1]}" does not resolve — Pages/Workers builds fail with "Could not resolve"`);
    }
  }
}

// Pages Functions must export onRequest*/onRequest, Workers must export default.
for (const f of fs.readdirSync(path.join(root, 'functions/api'), { recursive: true })) {
  const name = String(f);
  if (!name.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(root, 'functions/api', name), 'utf8');
  if (!/export\s+const\s+(onRequest|onRequestGet|onRequestPost)/.test(src)) errors.push(`functions/api/${name}: no onRequest export, so Pages will not route it`);
}
if (!/export\s+default\s*\{/.test(read('worker/index.js'))) errors.push('worker/index.js must `export default { fetch }`');
if (!/handleApi/.test(read('worker/index.js'))) warnings.push('worker/index.js does not call shared/api.js; Pages and Worker behaviour can drift');

/* ------------------------------------------------------------ secrets */

// Anything that looks like a live credential must never reach a public repo —
// these files are served to every visitor. Placeholders used in docs/tests are skipped.
const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{28,}/, 'Google API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, 'OpenAI-style key'],
  [/\bpt_[A-Za-z0-9_-]{20,}/, 'Cloudflare API token'],
  [/\btrl_[A-Za-z0-9]{20,}/, 'Paddle webhook secret'],
  [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT (service role key?)'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key']
];
const PLACEHOLDER = /(FAKE|TEST|EXAMPLE|DEMO|DUMMY|REPLACE|PLACEHOLDER|YOUR[-_]|CHANGEME|SAMPLE|X{4,}|0{6,})/i;
const isScanned = (f) => !/(^|\/)(tests|scripts|node_modules|\.git|\.wrangler)\//.test(f) && !/\.(md|example|lock)$/i.test(f) && !f.endsWith('.dev.vars.example');
const scanFiles = jsFiles.map(rel).concat(['public/index.html', 'wrangler.json', 'supabase/schema.sql']).filter((f) => isScanned(f) && exists(f));
for (const f of scanFiles) {
  const src = read(f);
  for (const [pattern, what] of SECRET_PATTERNS) {
    const m = src.match(pattern);
    if (m && !PLACEHOLDER.test(m[0])) errors.push(`${f}: looks like a real ${what} (${m[0].slice(0, 8)}…). Rotate it in the provider dashboard and keep secrets in Cloudflare only.`);
  }
}
if (exists('.dev.vars') && !exists('.gitignore')) errors.push('.dev.vars exists but there is no .gitignore — local secrets could be committed');

/* ------------------------------------------------------------- netlify */
// This repo is also connected to a Netlify site. A netlify.toml overrides the dashboard's
// build settings, so a stale "publish = ." there can no longer produce a blank deploy.
if (exists('netlify.toml')) {
  const toml = read('netlify.toml');
  const pub = (toml.match(/publish\s*=\s*"?([^"\n]+)"?/) || [])[1] || '';
  if (assetsDir && pub.trim().replace(/^\.\//, '') !== assetsDir.replace(/\/+$/, '')) {
    errors.push(`netlify.toml publishes "${pub.trim()}" but wrangler.json uses "${assetsDir}" — the two hosts would serve different trees`);
  }
  if (!toml.includes('/api/*')) errors.push('netlify.toml has no /api/* redirect, so the Netlify deploy has no chat API');
  if (!exists('netlify/functions/api.mjs')) warnings.push('netlify.toml redirects /api/* but netlify/functions/api.mjs is missing');
}

/* --------------------------------------------------- setup leftovers */

for (const [file, pattern, note] of [
  ['public/sitemap.xml', /YOUR-DOMAIN/, 'sitemap.xml still points at YOUR-DOMAIN — replace it before submitting to Google Search Console'],
  ['public/robots.txt', /YOUR-DOMAIN/, 'robots.txt still points at YOUR-DOMAIN'],
  ['public/index.html', /YOUR-DOMAIN/, 'index.html still has YOUR-DOMAIN in canonical/og:url — the runtime fallback fixes social previews, but set the real domain for Search Console'],
  ['public/tiers.js', /pri_REPLACE_ME/, 'tiers.js still has pri_REPLACE_ME — the pricing page stays in preview mode until real Paddle price IDs are set']
]) {
  if (pattern.test(read(file))) warnings.push(`${file}: ${note}`);
}
// A pasted key in the page is the single most dangerous slip; assignment-style strings are enough.
if (/(?:GEMINI_API_KEY|apiKey|api_key|PADDLE_CLIENT_TOKEN)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/.test(html) && !PLACEHOLDER.test(html)) {
  errors.push('index.html appears to hard-code an API key or token. Keys belong in Cloudflare secrets, never in the page.');
}

/* -------------------------------------------------------------- output */

const annotate = (level, msg) => (process.env.GITHUB_ACTIONS ? `::${level}::${msg}` : `${level === 'error' ? '✖' : '!'} ${msg}`);
for (const e of errors) console.error(annotate('error', e));
for (const w of warnings) console.log(annotate('warning', w));

if (errors.length) {
  console.error(`\n${errors.length} problem(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`\n✓ structure OK (${jsFiles.length} JS files, public/ assets wired, ${warnings.length} setup warning(s)).`);
