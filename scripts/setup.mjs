#!/usr/bin/env node
/*
 * Realm AI setup assistant — node scripts/setup.mjs <command> [flags]
 *
 *   doctor    Read-only: is this repo + your secrets configured enough to run and to take money?
 *   gemini    Validate a Gemini API key against Google, pick a model that actually exists,
 *             write it into .dev.vars, and print (or run) the command that sets it on your host.
 *   paddle    Validate a Paddle API key, create the paid plans (products + prices) in the right
 *             Paddle environment, and write the returned pri_... ids into public/tiers.js.
 *
 * Why this exists: the account side (Paddle sandbox/live, AI Studio key, Supabase project) has to be
 * clicked by a human — email, password, phone verification. Everything AFTER that is mechanical, and
 * mechanical steps are where copy-paste goes wrong: wrong Paddle environment, price ids left as
 * REPLACE_ME, a sandbox key wired to a live client token. This script checks and fixes those.
 *
 * Secrets policy: never pass a key as a command-line argument if anyone can read your shell history —
 * prefer the environment variable form, and this script never prints a secret back (only a mask).
 *
 * Useful flags
 *   --dry-run          show the API calls instead of making them
 *   --no-write         do not touch .dev.vars / public/tiers.js
 *   --yes              non-interactive: never prompt, report what is missing instead
 *   --base <url>       provider base URL (used by tests and by proxies)
 *   --prices 4,12,29   monthly USD amounts for starter,pro,business (yearly defaults to 10 months)
 *   --netlify [site]   push secrets with the Netlify CLI
 *   --wrangler         push secrets with `wrangler secret put`
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const TIERS = path.join(ROOT, 'public', 'tiers.js');
const TOML = path.join(ROOT, 'netlify.toml');
const money = (value) => {
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* --------------------------------------------------------------- small utils */

const read = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
};
const write = (file, text) => {
  fs.writeFileSync(file, text, 'utf8');
  return path.relative(ROOT, file);
};
const isSecret = (key) => /API_KEY|TOKEN|SECRET|SERVICE_ROLE|_KEY$/i.test(key);
export const mask = (value) => {
  const v = String(value || '');
  if (!v) return '(unset)';
  if (v.length <= 10) return `${v.slice(0, 2)}••••`;
  return `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`;
};
const ok = (label) => `  ✓ ${label}`;
const warn = (label) => `  ⚠ ${label}`;
const bad = (label) => `  ✗ ${label}`;

export function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { flags._.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else { flags[name] = next; i++; }
  }
  return flags;
}

/* ---------------------------------------------------------------- .dev.vars */

export function parseDevVars(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Merge updates into .dev.vars, preserving comments and order; unknown keys are appended. */
export function mergeDevVars(text, updates) {
  const lines = String(text || '').split('\n');
  const done = new Set();
  const next = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !(m[1] in updates)) return line;
    done.add(m[1]);
    const value = String(updates[m[1]]);
    const quote = /^\s*[#]|["']/.test(value) ? '' : value.includes(' ') ? '"' : '';
    return `${m[1]}=${quote}${value}${quote}`;
  });
  const fresh = Object.entries(updates).filter(([k]) => !done.has(k));
  if (fresh.length) {
    while (next.length && next[next.length - 1].trim() === '') next.pop();
    if (next.length) next.push('');
    next.push(`# added by scripts/setup.mjs on ${new Date().toISOString().slice(0, 10)}`);
    for (const [k, v] of fresh) next.push(`${k}=${v}`);
    next.push('');
  }
  return next.join('\n');
}

/* ------------------------------------------------------------------ doctor */

export function doctorFindings({ vars, tiersText, tomlText }) {
  const findings = [];
  const add = (level, msg, fix) => findings.push({ level, msg, fix });

  const key = vars.GEMINI_API_KEY || '';
  if (!key || /REPLACE_ME|your-key|test-key/i.test(key)) {
    add('fail', 'GEMINI_API_KEY is missing or still a placeholder.',
      'Create one at https://aistudio.google.com/apikey, then: GEMINI_API_KEY=<key> node scripts/setup.mjs gemini');
  } else if (!/^AIza/.test(key)) {
    add('warn', `GEMINI_API_KEY does not look like a Google AI Studio key (${mask(key)}).`,
      'AI Studio keys start with "AIza". A Paddle/Stripe key here will fail every request.');
  } else {
    add('pass', `GEMINI_API_KEY set (${mask(key)}).`);
  }

  const model = vars.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  add('info', `GEMINI_MODEL=${model}${vars.GEMINI_MODEL_FALLBACK ? ` (fallback ${vars.GEMINI_MODEL_FALLBACK})` : ' — no fallback set'}.`);

  const env = (vars.PADDLE_ENV || '').toLowerCase();
  const clientToken = vars.PADDLE_CLIENT_TOKEN || '';
  const apiKey = vars.PADDLE_API_KEY || '';
  if (!clientToken && !apiKey) {
    add('fail', 'No Paddle credentials in .dev.vars.',
      'Create the sandbox account (https://sandbox-vendors.paddle.com/signup), then Developer tools → Authentication for the API key (pdl_sdbx…) and the client-side token (test_…). Run: node scripts/setup.mjs paddle');
  } else {
    const sandboxToken = clientToken.startsWith('test_');
    if (env === 'production' && (sandboxToken || apiKey.includes('_sdbx'))) {
      add('fail', 'PADDLE_ENV=production but the credentials are sandbox ones.',
        'Paddle live and sandbox are separate accounts. Set PADDLE_ENV=sandbox, or use your live pdl_ key with no _sdbx and a live token.');
    } else if (env === 'sandbox' && clientToken && !sandboxToken) {
      add('fail', 'PADDLE_ENV=sandbox but PADDLE_CLIENT_TOKEN does not start with "test_".',
        'That is a live token — checkout would fail. Copy the token shown while the dashboard says "Sandbox".');
    } else {
      add('pass', `Paddle credentials present for PADDLE_ENV=${env || '(unset → client falls back to sandbox)'}.`);
    }
    if (clientToken && !apiKey) add('warn', 'PADDLE_CLIENT_TOKEN set but no PADDLE_API_KEY.', 'Checkout works; /api/checkout-status and webhook activation stay off.');
    if (apiKey && !vars.PADDLE_WEBHOOK_SECRET) add('warn', 'No PADDLE_WEBHOOK_SECRET.', 'Dashboard → Developer tools → Webhooks → signing secret (trl_…). Without it every notification is refused.');
  }

  const tiers = readTiers(tiersText);
  if (!tiers.length) {
    add('fail', 'public/tiers.js could not be read as REALM_TIERS.', 'Keep `window.REALM_TIERS = [ … ]` — the pricing page and this script both parse it.');
  }
  for (const tier of tiers) {
    const ids = tier.priceId || {};
    const missing = ['month', 'year'].filter((cycle) => !/^pri_[a-z\d]{26}$/.test(String(ids[cycle] || '')));
    if (missing.length === 2) add('fail', `"${tier.name}" has no real price id in public/tiers.js.`, 'node scripts/setup.mjs paddle  (creates the products and fills this file)');
    else if (missing.length) add('warn', `"${tier.name}" is missing its ${missing.join(' and ')} price id.`, 'node scripts/setup.mjs paddle');
  }
  for (const tier of tiers) {
    if (!tier.name) add('fail', 'A tier in public/tiers.js has no `name`.', 'The pricing page uses it as the plan label and as Paddle customData.tier.');
    if (!Array.isArray(tier.features) || !tier.features.length) add('warn', `"${tier.name}" has no features list.`, 'The card looks broken with an empty list; add at least one string.');
    if (!money(tier.fallback?.month)) add('warn', `"${tier.name}" has no fallback price.`, 'While price ids are placeholders the page shows `fallback`, so add e.g. fallback: { month: "$5", year: "$50" }.');
  }
  if (tiers.length > 4) add('info', `${tiers.length} tiers — the grid is built for three.`, 'The page wraps onto extra rows; fine, just check it looks right.');

  if (!/SUPABASE_URL/.test(tomlText) && !vars.SUPABASE_URL) {
    add('info', 'Supabase not wired: webhooks will be verified and logged, not applied to plans.', 'Copy supabase/schema.sql into the SQL editor, then set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  }

  return findings;
}

/** public/tiers.js is an array of { name, priceId: { month, year }, fallback }, so read it for real. */
export function readTiers(text) {
  try {
    // The file assigns window.REALM_TIERS, so give the sandbox a `window` (Node has none).
    const factory = new Function('window', `${String(text || '')}\nreturn (window && window.REALM_TIERS) || (typeof REALM_TIERS !== "undefined" ? REALM_TIERS : null);`);
    const list = factory({});
    if (!Array.isArray(list)) return [];
    return list.map((t) => ({
      name: String(t?.name || ''),
      description: String(t?.description || ''),
      features: Array.isArray(t?.features) ? t.features : [],
      priceId: { ...(t?.priceId || {}) },
      fallback: { ...(t?.fallback || {}) }
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ gemini */

export async function listGeminiModels({ base = 'https://generativelanguage.googleapis.com', key, fetchImpl = fetch }) {
  if (!key) return { ok: false, error: 'no key supplied' };
  let res;
  try {
    res = await fetchImpl(`${base}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`, { headers: { accept: 'application/json' } });
  } catch (error) {
    return { ok: false, error: `network: ${String(error?.message || error)}` };
  }
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text || '{}'); } catch { body = {}; }
  if (!res.ok) {
    const message = body?.error?.message || text.slice(0, 160);
    let hint = 'Check the key at https://aistudio.google.com/apikey.';
    if (res.status === 400 || res.status === 401 || res.status === 403) hint = 'The key was rejected. Copy it again from AI Studio (no spaces/quotes), and check the project has the Generative Language API enabled.';
    else if (res.status === 429) hint = 'Free-tier quota for this key is used up, or the key is new — wait a minute and retry.';
    return { ok: false, status: res.status, error: `${message} — ${hint}` };
  }
  if (!Array.isArray(body.models)) {
    // HTTP 200 with HTML/empty is what a captive portal, corporate proxy or Cloudflare page looks like.
    const preview = text.replace(/AIza[\w-]{4,}/g, 'AIza•••').replace(/\s+/g, ' ').slice(0, 90);
    return { ok: false, error: `Google did not return a model list (content-type ${res.headers.get('content-type') || 'unknown'}). Something answered instead of the API — a proxy, a login page, or a captive portal. It said: ${preview}` };
  }
  const models = body.models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''));
  return { ok: true, models };
}

/** Prefer the configured model, then the lite/flash family, then whatever answers. */
export function chooseModel(models, preferred = 'gemini-2.5-flash-lite') {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return { model: preferred, note: 'no model list — keeping the default' };
  const exact = list.includes(preferred) ? preferred : null;
  const pick = exact
    || list.find((m) => /flash-lite/.test(m))
    || list.find((m) => /flash/.test(m))
    || list.find((m) => /gemini/.test(m))
    || list[0];
  return {
    model: pick,
    fallback: pick === preferred ? (list.find((m) => m !== pick) || null) : preferred,
    note: exact ? 'requested model is available on this key' : `${preferred} is not on this key; using ${pick}`
  };
}

/* ------------------------------------------------------------------ paddle */

/** Sandbox and live are different accounts, so the base URL has to follow the key. */
export const paddleBase = (key, explicit) => {
  if (explicit) return String(explicit).replace(/\/+$/, '');
  return String(key || '').includes('_sdbx') ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
};

export function checkPaddleKeyPair(key, clientToken) {
  const hasSdbx = String(key || '').includes('_sdbx');
  const testToken = String(clientToken || '').startsWith('test_');
  if (!key) return { level: 'fail', msg: 'No Paddle API key.' };
  if (!/^pdl_[a-z0-9_]+$/i.test(String(key))) return { level: 'fail', msg: 'That is not a Paddle API key (expected pdl_…). AI Studio keys start with "AIza" — do not paste one here.' };
  if (clientToken && hasSdbx !== testToken) {
    return { level: 'fail', msg: `Key is ${hasSdbx ? 'sandbox' : 'live'} but the client token is ${testToken ? 'sandbox' : 'live'}. Paddle will refuse every checkout.` };
  }
  return { level: 'pass', msg: `Key is for the ${hasSdbx ? 'SANDBOX' : 'LIVE'} environment${clientToken ? ' and matches the client token' : ''}.` };
}

/**
 * Products + prices to create, straight from public/tiers.js, so the catalog that lands in Paddle is
 * the catalog the page advertises. Amounts come from each tier's `fallback` label unless --prices overrides.
 */
export function buildCatalog(tiers, prices = []) {
  return tiers.map((entry, i) => {
    const tier = entry.name.toLowerCase();
    const override = money(prices[i]);
    const month = override ?? money(entry.fallback?.month) ?? 10;
    // An explicit monthly price implies a new yearly one (2 months free); otherwise trust the page.
    const year = override != null ? Math.round(month * 1000) / 100 : (money(entry.fallback?.year) ?? Math.round(month * 1000) / 100);
    return {
      tier,
      label: entry.name,
      product: {
        name: `Realm AI ${entry.name}`,
        description: `Realm AI ${entry.name} plan — billed by Paddle.`,
        tax_category: 'saas'
      },
      prices: [
        { cycle: 'month', body: { description: `Realm AI ${entry.name} (monthly)`, unit_price: { amount: String(Math.round(month * 100)), currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 } } },
        { cycle: 'year', body: { description: `Realm AI ${entry.name} (yearly)`, unit_price: { amount: String(Math.round(year * 100)), currency_code: 'USD' }, billing_cycle: { interval: 'year', frequency: 1 } } }
      ],
      usd: { month, year }
    };
  });
}

/** Replace one priceId entry without reformatting the file (comments and descriptions survive). */
export function setPriceId(text, tier, cycle, id) {
  const source = String(text);
  const named = new RegExp(`name:\\s*['"\`]${tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'i').exec(source);
  const start = named ? named.index : source.indexOf(`"${tier}"`);
  if (start < 0) return { text: source, changed: false, reason: `tier "${tier}" not found` };
  const blockStart = source.indexOf('priceId', start);
  if (blockStart < 0) return { text, changed: false, reason: 'no priceId block' };
  const blockEnd = text.indexOf('}', blockStart);
  const block = text.slice(blockStart, blockEnd + 1);
  const re = new RegExp(`(${cycle}\\s*:\\s*)'[^']*'`);
  if (!re.test(block)) return { text: source, changed: false, reason: `no ${cycle} entry` };
  return { text: source.slice(0, blockStart) + block.replace(re, `$1'${id}'`) + source.slice(blockEnd + 1), changed: true };
}

export async function createCatalog({ base, key, catalog, fetchImpl = fetch, log = () => {}, dryRun = false }) {
  const call = async (method, route, body) => {
    if (dryRun) return { id: `pri_dryrun${Math.random().toString(36).slice(2, 8)}`, body };
    const res = await fetchImpl(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text || '{}'); } catch { data = {}; }
    if (!res.ok) {
      const err = data?.error || {};
      const detail = (err.details || []).map((d) => `${d.field}: ${d.message}`).join('; ');
      throw new Error(`${method} ${route} → HTTP ${res.status} ${err.code || ''} ${detail || err.message || text.slice(0, 120)}`.trim());
    }
    return data.data || {};
  };

  const created = [];
  for (const entry of catalog) {
    log(`  product "${entry.product.name}" …`);
    const product = await call('POST', '/products', entry.product);
    log(`    → ${product.id}`);
    const priceIds = { month: null, year: null };
    for (const price of entry.prices) {
      const body = { ...price.body, product_id: product.id };
      log(`  price ${entry.tier} ${price.cycle} $${entry.usd[price.cycle]} …`);
      const made = await call('POST', '/prices', body);
      priceIds[price.cycle] = made.id;
      log(`    → ${made.id}`);
    }
    created.push({ tier: entry.tier, productId: product.id, priceIds, usd: entry.usd });
  }
  return created;
}

/* ------------------------------------------------------------- host secrets */

function pushToHost({ netlifySite, useWrangler, updates, log = () => {} }) {
  const entries = Object.entries(updates);
  if (!entries.length) return { attempted: false };
  if (netlifySite !== undefined) {
    for (const [k, v] of entries) {
      const args = ['env:set', k, v];
      if (typeof netlifySite === 'string' && netlifySite !== true) args.push('--site', String(netlifySite));
      const res = spawnSync('npx', ['netlify', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      log(`  ${res.status === 0 ? '✓' : '✗'} netlify ${args[0]} ${k}${res.status === 0 ? '' : `\n${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 3).join('\n')}`}`);
    }
    log('  ⚠ Netlify reads function env at deploy time → redeploy after this (git push, or `npx netlify deploy --prod`).');
    return { attempted: true, host: 'netlify' };
  }
  if (useWrangler) {
    for (const [k, v] of entries) {
      // Every value this script pushes is environment-specific config, so secrets keep it simple.
      const res = spawnSync('npx', ['wrangler', 'secret', 'put', k], { input: `${v}\n`, cwd: ROOT, encoding: 'utf8' });
      log(`  ${res.status === 0 ? '✓' : '✗'} wrangler secret put ${k}${res.status === 0 ? '' : `\n${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 3).join('\n')}`}`);
    }
    log('  ⚠ then: npx wrangler deploy');
    return { attempted: true, host: 'workers' };
  }
  return { attempted: false };
}

function printHostCommands(updates) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  console.log('\nSet the same values on the host that serves /api (they are NOT read from .dev.vars in production):');
  console.log('  # Netlify (any plan, needs `npx netlify login` once)');
  for (const [k, v] of entries) console.log(`  npx netlify env:set ${k} ${isSecret(k) ? '<paste>' : `"${v}"`}`);
  console.log('  # …or Cloudflare Workers (paste at the prompt, nothing lands in your shell history)');
  for (const [k] of entries) console.log(`  npx wrangler secret put ${k}`);
  console.log('  Dashboard route (no CLI): Netlify → Site configuration → Environment variables → Add (check "Secret").');
}

/* ------------------------------------------------------------------ commands */

async function cmdDoctor(flags) {
  const vars = parseDevVars(read(DEV_VARS));
  const findings = doctorFindings({ vars, tiersText: read(TIERS), tomlText: read(TOML) });
  console.log(`Realm AI doctor — ${ROOT}`);
  console.log(read(DEV_VARS) ? `\n.dev.vars present (${Object.keys(vars).length} keys).` : '\nNo .dev.vars yet (cp .dev.vars.example .dev.vars).');
  let failures = 0;
  for (const f of findings) {
    if (f.level === 'fail') failures++;
    console.log(`${f.level === 'pass' ? ok(f.msg) : f.level === 'warn' ? warn(f.msg) : f.level === 'info' ? `  · ${f.msg}` : bad(f.msg)}`);
    if (f.fix && (f.level === 'fail' || f.level === 'warn')) console.log(`      fix: ${f.fix}`);
  }
  console.log(`\n${failures ? `${failures} blocking issue(s).` : 'No blocking issues. Run: npm test && npm run dev:mock'}`);
  return failures ? 1 : 0;
}

async function cmdGemini(flags) {
  const key = String(flags.key || process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    console.log('No key found.\n  Create one (free, ~30 seconds): https://aistudio.google.com/apikey → Create API key → copy it.\n  Then run:  GEMINI_API_KEY=<paste-here> node scripts/setup.mjs gemini\n  Never paste the key into the repo or a public issue; .dev.vars is gitignored.');
    return 1;
  }
  console.log(`Validating ${mask(key)} against ${flags.base || 'https://generativelanguage.googleapis.com'} …`);
  const listed = await listGeminiModels({ base: flags.base || 'https://generativelanguage.googleapis.com', key });
  if (!listed.ok) { console.log(bad(listed.error)); return 1; }
  console.log(ok(`key accepted — ${listed.models.length} chat models available on it`));

  const picked = chooseModel(listed.models, String(flags.model || 'gemini-2.5-flash-lite'));
  console.log(`  model: ${picked.model} (${picked.note})`);
  if (picked.fallback) console.log(`  fallback: ${picked.fallback}`);

  const updates = { GEMINI_API_KEY: key, GEMINI_MODEL: picked.model };
  if (picked.fallback) updates.GEMINI_MODEL_FALLBACK = picked.fallback;
  if (!flags['no-write']) {
    const file = write(DEV_VARS, mergeDevVars(read(DEV_VARS), updates));
    console.log(ok(`wrote ${file} (dev server restart needed)`));
  }
  pushToHost({ netlifySite: flags.netlify, useWrangler: flags.wrangler, updates, log: console.log });
  if (flags.netlify === undefined && !flags.wrangler) printHostCommands(updates);
  console.log('\nCheck it end to end:  npm run dev:mock   (or after deploy:  curl https://<yoursite>/api/health )');
  return 0;
}

async function cmdPaddle(flags) {
  const key = String(flags.key || process.env.PADDLE_API_KEY || '').trim();
  const clientToken = String(flags.clientToken || process.env.PADDLE_CLIENT_TOKEN || '').trim();
  const pair = checkPaddleKeyPair(key, clientToken);
  console.log(pair.msg);
  if (pair.level === 'fail') {
    console.log('  Sandbox keys/dashboard: https://sandbox-vendors.paddle.com → Developer tools → Authentication.\n  A live key comes from the main dashboard after Paddle approves the account.');
    return 1;
  }
  const base = paddleBase(key, flags.base);
  const tiers = readTiers(read(TIERS));
  if (!tiers.length) { console.log(bad(`Could not read plans from ${path.relative(ROOT, TIERS)}.`)); return 1; }
  const catalog = buildCatalog(tiers, String(flags.prices || '').split(',').filter(Boolean).map(Number));
  console.log(`Environment: ${base}${flags['dry-run'] ? '  (dry run — nothing will be created)' : ''}`);
  console.log(`Creating ${catalog.length} products and ${catalog.length * 2} prices (USD; Paddle converts the currency for each buyer):`);
  for (const entry of catalog) console.log(`  ${entry.tier}: $${entry.usd.month}/month · $${entry.usd.year}/year`);

  let created;
  try {
    created = await createCatalog({ base, key, catalog, log: console.log, dryRun: Boolean(flags['dry-run']) });
  } catch (error) {
    console.log(bad(String(error.message || error)));
    if (/403|forbidden/i.test(String(error.message))) {
      console.log('  → HTTP 403 usually means the key hit the wrong environment, or lacks the "Write" permission for products/prices.');
      console.log('    Sandbox keys must call https://sandbox-api.paddle.com; live keys https://api.paddle.com.');
    }
    if (/401|unauthor/i.test(String(error.message))) console.log('  → HTTP 401 means Paddle does not recognise this key. Regenerate it in the dashboard that matches the base URL above.');
    return 1;
  }

  if (flags['no-write'] || flags['dry-run']) {
    console.log('\nDry run / no-write: public/tiers.js left alone.');
    console.log('Re-run with --write-tiers (default) to fill the price ids, or paste them yourself:');
    for (const entry of created) console.log(`  ${entry.tier}: month ${entry.priceIds.month}, year ${entry.priceIds.year}`);
    return 0;
  }
  let text = read(TIERS);
  const applied = [];
  for (const entry of created) {
    for (const cycle of ['month', 'year']) {
      const res = setPriceId(text, entry.tier, cycle, entry.priceIds[cycle]);
      text = res.text;
      applied.push(`${entry.tier}.${cycle}${res.changed ? '' : ` (${res.reason})`}`);
    }
  }
  write(TIERS, text);
  console.log(`\n✓ wrote price ids to ${path.relative(ROOT, TIERS)} → ${applied.join(', ')}`);

  const varsUpdates = { PADDLE_ENV: base.includes('sandbox-api') || String(key).includes('_sdbx') ? 'sandbox' : 'production' };
  if (clientToken) varsUpdates.PADDLE_CLIENT_TOKEN = clientToken;
  if (key) varsUpdates.PADDLE_API_KEY = key;
  if (!flags['no-write']) {
    write(DEV_VARS, mergeDevVars(read(DEV_VARS), varsUpdates));
    console.log(`✓ wrote ${path.relative(ROOT, DEV_VARS)} (PADDLE_ENV=${varsUpdates.PADDLE_ENV})`);
  }

  printHostCommands(Object.fromEntries(Object.entries(varsUpdates).filter(([k]) => k !== 'PADDLE_CLIENT_TOKEN')));
  console.log('\nLast two steps, both in the Paddle dashboard (they need a human):');
  console.log('  1. Developer tools → Webhooks → Add endpoint');
  console.log(`     URL  https://<your-site>/api/paddle/webhook      (or the Worker URL if you split hosts)`);
  console.log(`     Events subscription.*, transaction.*, payment_method.*  ·  copy the signing secret (trl_…)`);
  console.log('  2. Set that secret: npx netlify env:set PADDLE_WEBHOOK_SECRET <trl_…>   then redeploy.');
  console.log('\nTest a checkout: pricing page → choose a plan → card 4242 4242 4242 4242, any future date, any CVC.');
  console.log('Sandbox receipts only reach an address @your-registered-domain (Paddle anti-abuse) — check your own inbox, not a Gmail alias.');
  return 0;
}

/* --------------------------------------------------------------------- main */

export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const command = flags._[0] || 'doctor';
  if (command === 'doctor') return cmdDoctor(flags);
  if (command === 'gemini') return cmdGemini(flags);
  if (command === 'paddle') return cmdPaddle(flags);
  console.log(`Realm AI setup — node scripts/setup.mjs <command>

  doctor    what is configured, what is missing (safe, read-only)
  gemini    validate your Google AI Studio key, pick a model, write .dev.vars
  paddle    create products + prices in the right Paddle environment, fill tiers.js

  Every command accepts --dry-run and --no-write. Secrets: pass them via the environment, e.g.
    GEMINI_API_KEY=AIza… node scripts/setup.mjs gemini
    PADDLE_API_KEY=pdl_sdbx… node scripts/setup.mjs paddle --prices 4,12,29`);
  return command === 'help' ? 0 : 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().then((code) => { process.exitCode = code; }, (error) => { console.error(error?.message || error); process.exitCode = 1; });
