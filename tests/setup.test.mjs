#!/usr/bin/env node
/**
 * Tests for scripts/setup.mjs — the account/commerce assistant.
 *
 * These matter because the script edits real files (.dev.vars, public/tiers.js) and talks to Paddle and
 * Google. Everything here runs offline: provider calls go to a local mock server, so CI catches a broken
 * doctor, a clobbered tiers.js, or a catalog whose bodies Paddle would reject.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, mask, parseDevVars, mergeDevVars, doctorFindings, readTiers, listGeminiModels, chooseModel,
  paddleBase, checkPaddleKeyPair, buildCatalog, setPriceId, createCatalog
} from '../scripts/setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✖ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

/* ------------------------------------------------------- a tiny stand-in backend */

const created = { products: [], prices: [] };
let failNext = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const json = (() => { try { return JSON.parse(body || 'null'); } catch { return null; } })();
    const auth = String(req.headers.authorization || '');
    if (req.url.startsWith('/v1beta/models')) {
      // The key picks the behaviour, so listGeminiModels() needs no test-only options.
      if (!/key=AIza/.test(req.url)) return send(400, { error: { code: 400, message: 'API key not valid.' } });
      if (/key=AIzaEMPTY/.test(req.url)) return send(200, { models: [] });
      if (/key=AIzaHTML/.test(req.url)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>502 from a proxy, not JSON</html>'); }
      return send(200, {
        models: [
          ...['gemini-2.5-flash', 'gemini-2.5-pro'].map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })),
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
        ]
      });
    }
    if (req.url === '/products' && req.method === 'POST') {
      if (failNext === 'product') return send(400, { error: { code: 'bad_request', message: 'validation failed', details: [{ field: 'tax_category', message: 'required' }] } });
      if (!/^Bearer pdl_/.test(auth)) return send(401, { error: { code: 'unauthorized', message: 'no' } });
      const row = { id: `pro_${'p'.repeat(26) + created.products.length}`, ...json };
      created.products.push(row);
      return send(201, { data: row });
    }
    if (req.url === '/prices' && req.method === 'POST') {
      const row = { id: `pri_${'x'.repeat(25) + created.prices.length}`, ...json };
      created.prices.push(row);
      return send(201, { data: row });
    }
    return send(404, { error: { message: `mock does not serve ${req.url}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* --------------------------------------------------------------- arg + secret */

console.log('\narguments, masking, .dev.vars');
await test('parseArgs handles flags with and without values', () => {
  const f = parseArgs(['paddle', '--key', 'abc', '--dry-run', '--prices', '4,12']);
  assert.deepEqual(f._, ['paddle']);
  assert.equal(f.key, 'abc');
  assert.equal(f['dry-run'], true);
  assert.equal(f.prices, '4,12');
});
await test('mask never prints the middle of a secret', () => {
  const secret = 'pdl_sdbxSECRETDO_NOTLEAK99887766';
  const shown = mask(secret);
  assert.ok(!shown.includes('SECRETDO'), shown);
  assert.match(shown, /pdl_su?\S*…\S{4} \(\d+ chars\)/);
  assert.equal(mask(''), '(unset)');
  assert.equal(mask('short'), 'sh••••');
});
await test('parseDevVars tolerates quotes, spaces and comments', () => {
  const vars = parseDevVars(`# comment\nGEMINI_API_KEY="AIza123"\nEMPTY=\n  PADDLE_ENV = 'sandbox' \nlowercase_thing=x`);
  assert.equal(vars.GEMINI_API_KEY, 'AIza123');
  assert.equal(vars.EMPTY, '');
  assert.equal(vars.PADDLE_ENV, 'sandbox');
  assert.equal(vars.lowercase_thing, undefined, 'only UPPER_SNAKE keys are real env names');
});
await test('mergeDevVars keeps comments, updates in place, appends the new ones', () => {
  const original = `# my local settings\nGEMINI_API_KEY=old\nGEMINI_MODEL=gemini-1.0\n`;
  const next = mergeDevVars(original, { GEMINI_API_KEY: 'AIzaNEW', PROVIDER_TIMEOUT_MS: '8000' });
  assert.match(next, /^# my local settings/, 'the header comment survives');
  assert.equal(parseDevVars(next).GEMINI_API_KEY, 'AIzaNEW');
  assert.equal(parseDevVars(next).GEMINI_MODEL, 'gemini-1.0', 'untouched keys stay untouched');
  assert.equal(parseDevVars(next).PROVIDER_TIMEOUT_MS, '8000');
  assert.equal((next.match(/GEMINI_API_KEY=/g) || []).length, 1, 'no duplicate keys');
});
await test('mergeDevVars quotes values containing spaces', () => {
  const next = mergeDevVars('', { NOTE: 'two words' });
  assert.equal(parseDevVars(next).NOTE, 'two words');
});

/* -------------------------------------------------------------------- doctor */

console.log('\ndoctor findings');
const TIERS_SAMPLE = fs.readFileSync(path.join(ROOT, 'public', 'tiers.js'), 'utf8');
const levels = (f) => f.filter((x) => x.level === 'fail').map((x) => x.msg);
await test('a fresh clone reports exactly what is missing', () => {
  const f = doctorFindings({ vars: {}, tiersText: TIERS_SAMPLE, tomlText: '' });
  const joined = levels(f).join(' | ');
  assert.match(joined, /GEMINI_API_KEY is missing|placeholder/i, joined);
  assert.match(joined, /No Paddle credentials/i, joined);
  assert.match(joined, /Starter.*no real price id/i, joined);
});
await test('a placeholder key is a failure, a real-looking one is not', () => {
  assert.ok(levels(doctorFindings({ vars: { GEMINI_API_KEY: 'REPLACE_ME' }, tiersText: TIERS_SAMPLE })).some((m) => /placeholder/i.test(m)));
  const f = doctorFindings({ vars: { GEMINI_API_KEY: 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUM' }, tiersText: TIERS_SAMPLE });
  assert.ok(!f.some((x) => /placeholder/i.test(x.msg)));
});
await test('mixing sandbox and live Paddle credentials is called out', () => {
  const mixed = doctorFindings({ vars: { GEMINI_API_KEY: 'AIzaX', PADDLE_ENV: 'production', PADDLE_CLIENT_TOKEN: 'test_abc' }, tiersText: TIERS_SAMPLE });
  assert.ok(mixed.some((x) => x.level === 'fail' && /sandbox/.test(x.msg) && /production/.test(x.msg)), JSON.stringify(mixed));
  const matched = doctorFindings({ vars: { GEMINI_API_KEY: 'AIzaX', PADDLE_ENV: 'sandbox', PADDLE_CLIENT_TOKEN: 'test_abc', PADDLE_API_KEY: 'pdl_sdbx_x' }, tiersText: TIERS_SAMPLE });
  assert.ok(matched.some((x) => x.level === 'pass' && /Paddle credentials present/.test(x.msg)), JSON.stringify(matched));
});
await test('a Gemini key in the Paddle slot is caught by the Paddle validator too', () => {
  const pair = checkPaddleKeyPair('AIzaSyDUMMYKEY', 'test_abc');
  assert.equal(pair.level, 'fail');
  assert.match(pair.msg, /not a Paddle API key/, pair.msg);
});
await test('ready price ids clear the tier failures', () => {
  const filled = TIERS_SAMPLE.replace(/pri_REPLACE_ME/g, () => `pri_${'a'.repeat(26)}`);
  const f = doctorFindings({ vars: { GEMINI_API_KEY: 'AIzaX' }, tiersText: filled });
  assert.ok(!f.some((x) => /price id/.test(x.msg)), JSON.stringify(f.filter((x) => x.level === 'fail')));
});

/* -------------------------------------------------------------- tiers.js edits */

console.log('\npublic/tiers.js is edited, not regenerated');
await test('readTiers parses the real file, keeping names and features', () => {
  const tiers = readTiers(TIERS_SAMPLE);
  assert.equal(tiers.length, 3);
  assert.deepEqual(tiers.map((t) => t.name), ['Starter', 'Pro', 'Advanced']);
  assert.ok(tiers[1].features.length >= 3, 'Pro lists features');
  assert.equal(readTiers('garbage ~~').length, 0, 'a broken file is reported as empty, not thrown');
});
await test('setPriceId replaces one id and leaves the rest of the file alone', () => {
  const out = setPriceId(TIERS_SAMPLE, 'Pro', 'month', 'pri_zzzzzzzzzzzzzzzzzzzzzzzzzz');
  assert.equal(out.changed, true);
  const tiers = readTiers(out.text);
  assert.equal(tiers[1].priceId.month, 'pri_zzzzzzzzzzzzzzzzzzzzzzzzzz');
  assert.equal(tiers[1].priceId.year, 'pri_REPLACE_ME', 'the other cycle is untouched');
  assert.equal(tiers[0].priceId.month, 'pri_REPLACE_ME');
  assert.equal(out.text.split('\n').length, TIERS_SAMPLE.split('\n').length, 'no reflowing');
  assert.match(out.text, /highlight: true/, 'formatting and comments survive');
});
await test('an unknown tier or cycle is reported instead of silently skipped', () => {
  assert.match(setPriceId(TIERS_SAMPLE, 'Nope', 'month', 'pri_x').reason, /not found/);
  assert.match(setPriceId(TIERS_SAMPLE, 'Pro', 'decade', 'pri_x').reason, /no decade entry/);
});

/* -------------------------------------------------------------------- catalog */

console.log('\nPaddle catalog');
await test('catalog prices come from the page itself', () => {
  const catalog = buildCatalog(readTiers(TIERS_SAMPLE));
  assert.deepEqual(catalog.map((c) => c.tier), ['starter', 'pro', 'advanced']);
  assert.deepEqual(catalog.map((c) => c.usd.month), [5, 15, 25]);
  assert.deepEqual(catalog.map((c) => c.usd.year), [50, 150, 250]);
  const pro = catalog[1];
  assert.equal(pro.product.tax_category, 'saas', 'Paddle rejects a product without a tax category');
  assert.equal(pro.product.name, 'Realm AI Pro');
  assert.equal(pro.prices[0].body.unit_price.amount, '1500', 'minor units, as a string');
  assert.equal(pro.prices[0].body.unit_price.currency_code, 'USD', 'PKR is not a Paddle currency');
  assert.deepEqual(pro.prices[1].body.billing_cycle, { interval: 'year', frequency: 1 });
});
await test('--prices overrides the amounts', () => {
  const catalog = buildCatalog(readTiers(TIERS_SAMPLE), [9, 19]);
  assert.equal(catalog[0].usd.month, 9);
  assert.equal(catalog[0].usd.year, 90, 'an overridden monthly price re-derives yearly (2 months free)');
  assert.equal(catalog[2].usd.month, 25, 'tiers with no override keep the price on the page');
  assert.equal(catalog[2].usd.year, 250);
  assert.equal(catalog[2].prices[0].body.unit_price.amount, '2500');
});
await test('the API base follows the key, since sandbox and live are separate accounts', () => {
  assert.equal(paddleBase('pdl_sdbxABC'), 'https://sandbox-api.paddle.com');
  assert.equal(paddleBase('pdl_LIVEABC'), 'https://api.paddle.com');
  assert.equal(paddleBase('pdl_sdbxABC', `${base}/`), base, '--base wins (tests, proxies)');
});
await test('createCatalog posts a product then two prices per tier', async () => {
  created.products.length = 0; created.prices.length = 0; failNext = null;
  const out = await createCatalog({ base, key: 'pdl_sdbxTEST', catalog: buildCatalog(readTiers(TIERS_SAMPLE)) });
  assert.equal(created.products.length, 3);
  assert.equal(created.prices.length, 6);
  assert.equal(created.prices[0].product_id, created.products[0].id, 'prices point at the product just created');
  assert.equal(out[0].priceIds.month, created.prices[0].id);
  assert.equal(out[2].priceIds.year, created.prices[5].id);
});
await test('a Paddle validation error names the offending field', async () => {
  created.products.length = 0; failNext = 'product';
  await assert.rejects(
    () => createCatalog({ base, key: 'pdl_sdbxTEST', catalog: buildCatalog(readTiers(TIERS_SAMPLE)).slice(0, 1) }),
    /tax_category: required/
  );
  failNext = null;
});
await test('dry run fabricates ids and calls nothing', async () => {
  created.products.length = 0;
  const out = await createCatalog({ base, key: 'pdl_sdbxTEST', catalog: buildCatalog(readTiers(TIERS_SAMPLE)), dryRun: true });
  assert.equal(created.products.length, 0);
  assert.equal(out.length, 3);
  assert.match(out[0].priceIds.month, /^pri_/);
});

/* -------------------------------------------------------------------- gemini */

console.log('\nGemini key validation');
await test('a rejected key comes back with an actionable hint', async () => {
  const r = await listGeminiModels({ base, key: 'pdl_sdbxWRONGSERVICE' });
  assert.equal(r.ok, false);
  assert.match(r.error, /API key not valid/, r.error);
  assert.match(r.error, /AI Studio/, r.error);
});
await test('an accepted key lists only chat-capable models', async () => {
  const r = await listGeminiModels({ base, key: 'AIzaGOOD' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['gemini-2.5-flash', 'gemini-2.5-pro'], 'only generateContent models are offered');
});
await test('a key that returns nothing usable is still reported honestly', async () => {
  const r = await listGeminiModels({ base, key: 'AIzaEMPTY' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, [], 'embedding-only keys must not be presented as chat models');
  const html = await listGeminiModels({ base, key: 'AIzaHTML' });
  assert.equal(html.ok, false, 'a proxy returning HTML is an error, not an empty model list');
  assert.match(html.error, /502 from a proxy/, html.error);
});
await test('model choice falls back when the requested one is missing', () => {
  const withLite = chooseModel(['gemini-2.5-flash-lite', 'gemini-2.5-pro'], 'gemini-2.5-flash-lite');
  assert.equal(withLite.model, 'gemini-2.5-flash-lite');
  assert.equal(withLite.fallback, 'gemini-2.5-pro');
  const noLite = chooseModel(['gemini-2.5-flash', 'gemini-1.5-pro'], 'gemini-2.5-flash-lite');
  assert.equal(noLite.model, 'gemini-2.5-flash', 'prefers flash over an unrelated model');
  assert.equal(noLite.fallback, 'gemini-2.5-flash-lite', 'keeps the requested name as the fallback');
  assert.match(noLite.note, /not on this key/);
  assert.equal(chooseModel([], 'gemini-x').model, 'gemini-x', 'an empty list keeps the default rather than guessing');
});
await test('a network failure is reported, not thrown', async () => {
  const r = await listGeminiModels({ base: 'http://127.0.0.1:1', key: 'AIzaGOOD' });
  assert.equal(r.ok, false);
  assert.match(r.error, /network/);
});

server.close();
console.log(`\n${passed} setup-script check(s) passed${process.exitCode ? ' — with failures' : ''}.\n`);
