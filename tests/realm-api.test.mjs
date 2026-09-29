#!/usr/bin/env node
/**
 * Realm AI — logic tests for the shared API layer (no network, no Cloudflare account needed).
 *   npm test
 * These cover the parts that silently break a deployment: message normalisation, the
 * Gemini transcript shape, Paddle webhook signature verification and route dispatch.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleApi, normalizeMessages, toContents, extractText, verifyPaddleSignature, parseJsonObject, paddleApiBase, applyWebhookEvent, ROUTES } from '../shared/api.js';

const enc = new TextEncoder();
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✖ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

/** Env stub: no secrets set, which is the state a fresh deployment ships in. */
const EMPTY = {};

const post = (path, body, headers = {}) =>
  new Request(`https://realm.test${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

async function sign(secret, ts, body, algorithm = 'SHA-256') {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${body}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

console.log('\nnormalizeMessages');
await test('accepts a clean user/assistant history', async () => {
  const r = normalizeMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.equal(r.error, undefined);
  assert.equal(r.messages.length, 2);
});
await test('keeps one system message at the front, drops junk roles', async () => {
  const r = normalizeMessages([{ role: 'system', content: 'be nice' }, { role: 'wizard', content: 'x' }, { role: 'user', content: ' hi ' }]);
  assert.deepEqual(r.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(r.messages[1].content, 'hi');
});
await test('rejects an empty conversation and a non-array without prompt', async () => {
  assert.ok(normalizeMessages([]).error);
  assert.ok(normalizeMessages(undefined).error);
  assert.ok(normalizeMessages([{ role: 'assistant', content: 'only a reply' }]).error);
});
await test('accepts the {prompt} shorthand and truncates oversized content', async () => {
  const r = normalizeMessages('Explain recursion');
  assert.equal(r.messages[0].content, 'Explain recursion');
  const big = normalizeMessages([{ role: 'user', content: 'a'.repeat(99999) }]);
  assert.ok(big.messages[0].content.length <= 24000);
});

console.log('\ntoContents (Gemini transcript rules)');
await test('maps roles, drops system, requires a leading user turn', async () => {
  const t = toContents([{ role: 'system', content: 's' }, { role: 'assistant', content: 'orphan reply' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(t.map((x) => x.role), ['user', 'model']);
});
await test('merges consecutive same-role turns (providers reject those)', async () => {
  const t = toContents([{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }]);
  assert.equal(t.length, 1);
  assert.equal(t[0].parts[0].text, 'one\n\ntwo');
});
await test('extractText skips reasoning parts and joins answer parts', async () => {
  const text = extractText({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'A' }, { text: 'B' }] } }] });
  assert.equal(text, 'AB');
});

console.log('\nroute dispatch with no secrets configured');
await test('GET /api/health answers and never leaks secret values', async () => {
  const res = await handleApi(new Request('https://realm.test/api/health'), EMPTY);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ai.configured, false);
  assert.equal(JSON.stringify(body).includes('AIza'), false);
});
await test('POST /api/chat says the AI is not configured (503 + code) so the UI can help', async () => {
  const res = await handleApi(post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }), EMPTY);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'AI_NOT_CONFIGURED');
});
await test('GET /api/paddle-config reports billing as not configured (503 + code)', async () => {
  const res = await handleApi(new Request('https://realm.test/api/paddle-config'), EMPTY);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'PADDLE_NOT_CONFIGURED');
});
await test('wrong method gets 405, unknown API path gets 404 with a hint', async () => {
  assert.equal((await handleApi(new Request('https://realm.test/api/chat'), EMPTY)).status, 405);
  const nf = await handleApi(new Request('https://realm.test/api/nope'), EMPTY);
  assert.equal(nf.status, 404);
  assert.match((await nf.json()).error, /\/api\/health/);
});
await test('non-API paths return null so static assets can answer', async () => {
  assert.equal(await handleApi(new Request('https://realm.test/index.html'), EMPTY), null);
  assert.equal(await handleApi(new Request('https://realm.test/welcome.html'), EMPTY), null);
});
await test('malformed JSON and huge bodies are rejected, not crashed', async () => {
  assert.equal((await handleApi(post('/api/chat', '{oops', {}), { GEMINI_API_KEY: 'k' })).status, 400);
  const huge = post('/api/chat', JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(600 * 1024) }] }));
  assert.equal((await handleApi(huge, { GEMINI_API_KEY: 'k' })).status, 413);
});
await test('a misconfigured PADDLE_ENV is refused instead of half-working', async () => {
  const res = await handleApi(new Request('https://realm.test/api/paddle-config'), { PADDLE_ENV: 'sandbox', PADDLE_CLIENT_TOKEN: 'live_nope' });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'PADDLE_TOKEN_MISMATCH');
  const bad = await handleApi(new Request('https://realm.test/api/paddle-config'), { PADDLE_ENV: 'test', PADDLE_CLIENT_TOKEN: 'test_x' });
  assert.equal((await bad.json()).code, 'PADDLE_ENV_INVALID');
});

console.log('\nPaddle webhook signature');
const secret = 'whsec_test_secret';
await test('rejects when the secret is not configured', async () => {
  const res = await handleApi(post('/api/paddle/webhook', { event_id: 'evt_1' }), EMPTY);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'WEBHOOK_NOT_CONFIGURED');
});
await test('rejects a forged/unsigned notification', async () => {
  const res = await handleApi(post('/api/paddle/webhook', { event_id: 'evt_2' }), { PADDLE_WEBHOOK_SECRET: secret });
  assert.equal(res.status, 401);
});
await test('accepts a correctly signed notification and acks it', async () => {
  const body = JSON.stringify({ event_id: 'evt_3', event_type: 'transaction.paid', data: { id: 'txn_1' } });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = await sign(secret, ts, body);
  const res = await handleApi(
    new Request('https://realm.test/api/paddle/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};v1=${v1}` } }),
    { PADDLE_WEBHOOK_SECRET: secret }
  );
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.received, true);
  assert.equal(json.event_type, 'transaction.paid');
  assert.equal(json.event_log, 'skipped'); // no Supabase configured
});
await test('rejects a wrong signature and a stale timestamp', async () => {
  const body = JSON.stringify({ event_id: 'evt_4' });
  const ts = Math.floor(Date.now() / 1000);
  const bad = await handleApi(new Request('https://realm.test/api/paddle/webhook', { method: 'POST', body, headers: { 'paddle-signature': `ts=${ts};v1=${'0'.repeat(64)}` } }), { PADDLE_WEBHOOK_SECRET: secret });
  assert.equal(bad.status, 401);
  const staleTs = ts - 3600;
  const stale = await handleApi(
    new Request('https://realm.test/api/paddle/webhook', { method: 'POST', body, headers: { 'paddle-signature': `ts=${staleTs};v1=${await sign(secret, staleTs, body)}` } }),
    { PADDLE_WEBHOOK_SECRET: secret }
  );
  assert.equal(stale.status, 401);
});
await test('a SHA-1 subkey (older Paddle accounts) is rejected on purpose', async () => {
  const body = JSON.stringify({ event_id: 'evt_5' });
  const ts = Math.floor(Date.now() / 1000);
  const sha1 = await sign(secret, ts, body, 'SHA-1');
  const res = await handleApi(new Request('https://realm.test/api/paddle/webhook', { method: 'POST', body, headers: { 'paddle-signature': `ts=${ts};v1=${sha1}` } }), { PADDLE_WEBHOOK_SECRET: secret });
  assert.equal(res.status, 401);
});

await test('a browser on another site is refused CORS until ALLOWED_ORIGINS says otherwise', async () => {
  const foreign = new Request('https://realm.test/api/health', { headers: { origin: 'https://skimmer.example' } });
  const denied = await handleApi(foreign, EMPTY);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const allowed = await handleApi(foreign, { ALLOWED_ORIGINS: 'https://skimmer.example' });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://skimmer.example');
  const preflight = await handleApi(new Request('https://realm.test/api/chat', { method: 'OPTIONS', headers: { origin: 'https://skimmer.example' } }), { ALLOWED_ORIGINS: 'https://skimmer.example' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
});

console.log('\nrate limiting (in-isolate fallback)');
await test('locks down after the configured burst and returns retry-after', async () => {
  const env = { GEMINI_API_KEY: 'k', RATE_LIMIT_PER_MINUTE: 3 };
  const results = [];
  for (let i = 0; i < 5; i++) {
    const res = await handleApi(new Request('https://realm.test/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' } }), env);
    results.push(res.status);
  }
  assert.ok(results.slice(0, 3).every((s) => s !== 429), `first requests should pass: ${results}`);
  assert.ok(results.slice(3).includes(429), `later requests should be limited: ${results}`);
});


console.log('\nGemini integration (against a local mock provider)');

/** Records every request the route makes so we can assert on headers + body shape. */
const seen = [];
const sbWrites = [];
let mockMode = 'ok';
let paddleMode = 'ok';
/* Paddle ids are `prefix_` + 26 chars; the last route segment's 5th char picks the fixture. */
const TXN = {
  a: { id: 'txn_aaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'paid', currency_code: 'USD', subtotal: '15.00', custom_data: { tier: 'Pro', billing: 'month' }, customer_id: 'ctm_1', subscription_id: 'sub_1', updated_at: '2026-09-29T10:00:00.000Z', invoice: { url: 'https://paddle.test/invoice/1.pdf' }, status_url: 'https://paddle.test/receipt/a', details: { totals: { grand_total: '15.00', tax: '0.00' } }, items: [{ price: { description: 'Realm AI Pro (monthly)' }, quantity: 1 }] },
  b: { id: 'txn_bbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'pending', currency_code: 'USD', subtotal: '15.00', custom_data: { tier: 'Pro', billing: 'month' }, items: [], details: {} },
  c: { id: 'txn_cccccccccccccccccccccccccc', status: 'canceled', currency_code: 'USD', custom_data: { tier: 'Pro', billing: 'year' }, items: [], details: {} }
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    seen.push({ url: req.url, headers: req.headers, method: req.method, body: parsed });
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? '' : JSON.stringify(obj)); };
    const route = req.url.split('?')[0];
    if (route.startsWith('/rest/v1/')) { sbWrites.push({ method: req.method, route, query: req.url.slice(route.length), row: parsed, prefer: req.headers.prefer, auth: req.headers.authorization }); return send(req.method === 'POST' ? 201 : 204, req.method === 'POST' ? [parsed] : {}); }
    if (route.startsWith('/transactions/')) {
      if (paddleMode === '404') return send(404, { error: { code: 'not_found', message: 'Transaction not found' } });
      if (paddleMode === '401') return send(401, { error: { code: 'unauthorized', message: 'This API key is not valid in this environment' } });
      return send(200, { data: TXN[route.split('/').pop().slice(4, 5)] || TXN.a });
    }
    if (route.startsWith('/customers/')) return send(200, { data: { id: route.split('/').pop(), email: 'buyer@example.com' } });
    if (mockMode === 'agent-plan') return send(200, { candidates: [{ content: { parts: [{ text: '{"steps":[{"title":"Research","detail":"collect facts"},{"title":"Draft","detail":"write the plan"},{"title":"Review","detail":"check gaps"}],"deliverable":"A day-by-day plan","missing":""}' }] }, finishReason: 'STOP' }] });
    if (mockMode === 'agent-prose') return send(200, { candidates: [{ content: { parts: [{ text: 'Here is what I would do: first gather the facts, then write the plan. I will keep it short and practical for a student team.' }] }, finishReason: 'STOP' }] });
    if (mockMode === 'agent-many') return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ steps: [{}, { title: 'a', detail: 'x' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }, { title: 'f' }, { title: 'g' }, { title: 'h' }], deliverable: 'd' }) }] } }] });
    if (mockMode === 'agent-step') return send(200, { candidates: [{ content: { parts: [{ text: 'third result: concrete work product for step c' }] } }] });
    if (mockMode === 'agent-verify') return send(200, { candidates: [{ content: { parts: [{ text: '{"verdict":"incomplete","gaps":["pricing numbers are missing"],"final":"# Launch week\n\nDay 1 …" }' }] } }] });
    if (mockMode === 'ok') return send(200, { candidates: [{ content: { parts: [{ text: 'Hello from ', thought: false }, { text: 'Gemini' }, { text: 'reasoning', thought: true }] }, finishReason: 'STOP' }] });
    if (mockMode === 'ratelimit') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' }); return res.end(JSON.stringify({ error: { message: 'Resource has been exhausted (quota).' } })); }
    if (mockMode === 'notfound') return send(404, { error: { code: 404, message: 'Model not found on this endpoint.' } });
    if (mockMode === 'key') return send(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } });
    if (mockMode === 'blocked') return send(200, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
    if (mockMode === 'truncated') return send(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
    if (mockMode === 'fallback-ok') return seen.length > 1 ? send(200, { candidates: [{ content: { parts: [{ text: 'recovered' }] }, finishReason: 'STOP' }] }) : send(404, { error: { message: 'Model not found.' } });
    if (mockMode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>proxy error</html>'); }
    return send(500, { error: { message: 'upstream exploded' } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const envWith = (extra = {}) => ({ GEMINI_API_KEY: 'AIzaTESTKEY1234567890', GEMINI_BASE_URL: base, RATE_LIMIT_PER_MINUTE: 0, ...extra });
const ask = async (env, messages = [{ role: 'user', content: 'hi there' }]) => {
  const res = await handleApi(post('/api/chat', { messages }), env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

await test('returns the answer text and hides reasoning parts', async () => {
  seen.length = 0; mockMode = 'ok';
  const { status, body } = await ask(envWith());
  assert.equal(status, 200);
  assert.equal(body.text, 'Hello from Gemini');
  assert.equal(body.model, 'gemini-2.5-flash-lite');
});
await test('sends the key in a header, never in the URL', async () => {
  const req = seen[seen.length - 1];
  assert.equal(req.headers['x-goog-api-key'], 'AIzaTESTKEY1234567890');
  assert.ok(!req.url.includes('AIza'), `key leaked into the request path: ${req.url}`);
  assert.ok(req.url.includes('/models/gemini-2.5-flash-lite:generateContent'));
});
await test('builds a valid Gemini request: system instruction + user-first contents', async () => {
  mockMode = 'ok';
  await ask(envWith(), [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }]);
  const req = seen[seen.length - 1].body;
  assert.equal(req.systemInstruction.parts[0].text, 'be terse');
  assert.deepEqual(req.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(typeof req.generationConfig.temperature, 'number');
});
await test('respects GEMINI_MODEL and thinking budget', async () => {
  mockMode = 'ok';
  await ask(envWith({ GEMINI_MODEL: 'gemini-2.5-flash', GEMINI_THINKING_BUDGET: '0' }));
  assert.ok(seen[seen.length - 1].url.includes('gemini-2.5-flash:generateContent'));
  assert.deepEqual(seen[seen.length - 1].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});
await test('provider 429 becomes a friendly retry message with Retry-After', async () => {
  mockMode = 'ratelimit';
  const { status, body } = await ask(envWith());
  assert.equal(status, 429);
  assert.match(body.code, /PROVIDER_RATE_LIMIT/);
});
await test('a bad key is explained as a key problem', async () => {
  mockMode = 'key';
  const { body } = await ask(envWith());
  assert.equal(body.code, 'BAD_KEY');
  assert.match(body.error, /GEMINI_API_KEY is not valid/);
});
await test('an unknown model name points at GEMINI_MODEL and retries the fallback', async () => {
  mockMode = 'notfound';
  const { body } = await ask(envWith());
  assert.equal(body.code, 'MODEL_NOT_FOUND');
  assert.match(body.error, /GEMINI_MODEL/);

  mockMode = 'fallback-ok';
  seen.length = 0;
  const ok = await ask(envWith({ GEMINI_MODEL: 'broken-model', GEMINI_MODEL_FALLBACK: 'gemini-2.5-flash-lite' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.model, 'gemini-2.5-flash-lite');
});
await test('safety-blocked prompts come back as a normal message, not an error', async () => {
  mockMode = 'blocked';
  const { status, body } = await ask(envWith());
  assert.equal(status, 200);
  assert.equal(body.blocked, true);
  assert.match(body.text, /safety filter/);
});
await test('a token-capped answer tells the user what to change', async () => {
  mockMode = 'truncated';
  const { body } = await ask(envWith());
  assert.match(body.text, /token limit/);
});
await test('a non-JSON provider page becomes a clean 502 (no raw markup echoed)', async () => {
  mockMode = 'html';
  const { status, body } = await ask(envWith());
  assert.equal(status, 502);
  assert.equal(body.code, 'BAD_PROVIDER_REPLY');
  assert.ok(!/[<>]/.test(JSON.stringify(body)), 'provider body must not leak markup into the API response');
});
await test('the whole API stays usable when the provider returns garbage', async () => {
  mockMode = 'boom';
  const { status, body } = await ask(envWith());
  assert.equal(status, 502);
  assert.ok(body.error);
  assert.ok(!body.stack);
});


console.log('\nhost wrappers (Netlify mounts functions at a different path)');
const netlifyHandler = (await import('../netlify/functions/api.mjs')).default;
for (const route of ROUTES) {
  await test(`${route} is reachable through /.netlify/functions/api`, async () => {
    // checkout-status needs a syntactically real transaction id, otherwise the 400 is the right answer
    const path = '/.netlify/functions/api' + route.slice(4) + (route === '/api/checkout-status' ? `?txn=txn_${'a'.repeat(26)}` : '');
    const res = await netlifyHandler(new Request(`https://realm.netlify.app${path}`, { method: ['/api/chat', '/api/agent', '/api/paddle/webhook'].includes(route) ? 'POST' : 'GET', body: ['/api/chat', '/api/agent', '/api/paddle/webhook'].includes(route) ? '{}' : undefined, headers: { 'content-type': 'application/json' } }), { env: EMPTY });
    const json2 = await res.json();
    assert.ok([200, 503].includes(res.status), `${route} -> ${res.status} ${JSON.stringify(json2)}`);
    if (route !== '/api/health') assert.ok(json2.code || typeof json2.phase === 'string', `${route} must return a code or a phase`);
  });
}
await test('the Netlify wrapper never answers 404 for a known API path', async () => {
  const res = await netlifyHandler(new Request('https://realm.netlify.app/.netlify/functions/api/nope'), { env: EMPTY });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'ROUTE_NOT_FOUND');
});
await test('env is read from context.env, netlify.env and process.env alike', async () => {
  const { collectEnv } = await import('../shared/netlify-env.js');
  assert.equal(collectEnv({ env: { GEMINI_API_KEY: 'from_context' } }).GEMINI_API_KEY, 'from_context');
  assert.equal(
    collectEnv({ netlify: { env: { get: (k) => (k === 'GEMINI_API_KEY' ? 'from_helper' : undefined) } } }).GEMINI_API_KEY,
    'from_helper'
  );
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'from_process';
  assert.equal(collectEnv({}).GEMINI_API_KEY, 'from_process');
  if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
  assert.equal(collectEnv({ env: { UNKNOWN_VAR: 'x' } }).UNKNOWN_VAR, 'x');
  assert.equal(collectEnv(undefined).GEMINI_API_KEY, undefined);
  // a broken context object must not take the function down
  assert.equal(collectEnv({ get env() { throw new Error('boom'); } }).GEMINI_API_KEY, undefined);
});
await test('missing env (context.env absent) degrades instead of crashing', async () => {
  const res = await netlifyHandler(new Request('https://realm.netlify.app/.netlify/functions/api/chat', { method: 'POST', body: '{"messages":[{"role":"user","content":"hi"}]}', headers: { 'content-type': 'application/json' } }), {});
  assert.equal(res.status, 503);
});


console.log('\nAgent runner (plan / step / verify) against the mock provider');
const agentPost = async (body, env = envWith()) => {
  const res = await handleApi(post('/api/agent', body), env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
await test('refuses politely when the AI secret is missing', async () => {
  const { status, body } = await agentPost({ phase: 'plan', goal: 'x' }, { GEMINI_BASE_URL: base });
  assert.equal(status, 503);
  assert.equal(body.code, 'AI_NOT_CONFIGURED');
});
await test('rejects an unknown phase and an empty goal', async () => {
  assert.equal((await agentPost({ phase: 'teleport', goal: 'x' })).status, 400);
  assert.equal((await agentPost({ phase: 'plan', goal: '   ' })).status, 400);
});
await test('parseJsonObject survives fenced code blocks, prose and raw newlines in strings', async () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Sure! Here you go:\n{"a":[1,2]}\nHope that helps.'), { a: [1, 2] });
  assert.deepEqual(parseJsonObject('{"a":"line one\nline two\ttabbed"}'), { a: 'line one\nline two\ttabbed' });
  assert.equal(parseJsonObject('no json here'), null);
  assert.equal(parseJsonObject(null), null);
});
await test('plan phase asks the provider for JSON and normalises the steps', async () => {
  mockMode = 'agent-plan';
  const { status, body } = await agentPost({ goal: 'Plan a launch week for my study app', phase: 'plan' });
  assert.equal(status, 200);
  assert.equal(body.steps.length, 3, JSON.stringify(body));
  assert.deepEqual(body.steps.map((s) => s.id), [0, 1, 2]);
  assert.equal(body.deliverable, 'A day-by-day plan');
  assert.ok(/JSON only/.test(seen[seen.length - 1].body.systemInstruction.parts[0].text));
  assert.equal(seen[seen.length - 1].body.generationConfig.responseMimeType, 'application/json');
});
await test('a plan that ignores the JSON contract still yields a usable single step', async () => {
  mockMode = 'agent-prose';
  const { body } = await agentPost({ phase: 'plan', goal: 'g' });
  assert.equal(body.steps.length, 1);
  assert.equal(body.fallback, true);
  assert.ok(body.steps[0].detail.length > 5);
});
await test('plans are capped at 6 steps and junk steps are dropped', async () => {
  mockMode = 'agent-many';
  const { body } = await agentPost({ phase: 'plan', goal: 'g' });
  assert.equal(body.steps.length, 6);
  assert.ok(body.steps.every((s) => s.title));
});
await test('step phase carries prior outputs and only runs the requested step', async () => {
  mockMode = 'agent-step';
  seen.length = 0;
  const { status, body } = await agentPost({
    phase: 'step', goal: 'g', deliverable: 'd', stepIndex: 2,
    steps: [{ title: 'a' }, { title: 'b' }, { title: 'c', detail: 'do c' }],
    outputs: ['first result', 'second result']
  });
  assert.equal(status, 200);
  assert.equal(body.index, 2);
  const prompt = seen[0].body.contents[0].parts[0].text;
  assert.ok(/Step 1: a/.test(prompt) && /first result/.test(prompt), prompt);
  assert.ok(/Now do step 3 of 3/.test(prompt), prompt);
  assert.ok(!/second result[\s\S]*third/.test(prompt));
});
await test('a stepIndex outside the plan is a 400, not a crash', async () => {
  mockMode = 'agent-step';
  const { status } = await agentPost({ phase: 'step', goal: 'g', steps: [{ title: 'only' }], stepIndex: 7 });
  assert.equal(status, 400);
});
await test('verify phase returns verdict + gaps + final', async () => {
  mockMode = 'agent-verify';
  const { body } = await agentPost({ phase: 'verify', goal: 'g', steps: [{ title: 'a' }], outputs: ['did the thing'] });
  assert.equal(body.verdict, 'incomplete');
  assert.deepEqual(body.gaps, ['pricing numbers are missing']);
  assert.match(body.final, /launch week/i);
});
await test('verify degrades to the raw text when the model skips JSON', async () => {
  mockMode = 'agent-prose';
  const { body } = await agentPost({ phase: 'verify', goal: 'g', steps: [{ title: 'a' }], outputs: ['x'] });
  assert.equal(body.verdict, 'complete');
  assert.ok(body.final.length > 5);
});
await test('provider failures inside a run surface as retryable errors', async () => {
  mockMode = 'ratelimit';
  const { status, body } = await agentPost({ phase: 'step', goal: 'g', steps: [{ title: 'a' }], stepIndex: 0 });
  assert.equal(status, 429);
  assert.equal(body.code, 'PROVIDER_RATE_LIMIT');
});

console.log('\nPaddle: checkout confirmation (GET /api/checkout-status)');
const payEnv = (extra = {}) => envWith({ PADDLE_API_BASE: base, PADDLE_API_KEY: 'pdl_sdbxTESTKEY', ...extra });
const statusOf = async (txn, env = payEnv()) => {
  const res = await handleApi(new Request(`https://realm.test/api/checkout-status${txn ? `?txn=${txn}` : ''}`, { headers: { origin: 'https://realm.netlify.app' } }), env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
await test('refuses a made-up transaction id instead of calling Paddle', async () => {
  seen.length = 0;
  const { status, body } = await statusOf('txn_1', payEnv());
  assert.equal(status, 400);
  assert.equal(body.code, 'BAD_TRANSACTION_ID');
  assert.equal(seen.length, 0, 'must not forward garbage to Paddle');
});
await test('503 with a clear code when the server has no Paddle key', async () => {
  const { status, body } = await statusOf('txn_aaaaaaaaaaaaaaaaaaaaaaaaaa', envWith());
  assert.equal(status, 503);
  assert.equal(body.code, 'PADDLE_API_NOT_CONFIGURED');
});
await test('a paid transaction becomes a plan confirmation, in USD totals', async () => {
  seen.length = 0; paddleMode = 'ok';
  const { status, body } = await statusOf('txn_aaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(status, 200);
  assert.equal(body.paid, true);
  assert.equal(body.plan, 'Pro', 'plan comes from the customData we attach at checkout');
  assert.equal(body.total, '15.00');
  assert.equal(body.currency, 'USD');
  assert.equal(body.invoiceUrl, 'https://paddle.test/invoice/1.pdf');
  const req = seen[0];
  assert.equal(req.method, 'GET');
  assert.match(req.url, /^\/transactions\/txn_a/);
  assert.equal(req.headers.authorization, 'Bearer pdl_sdbxTESTKEY');
});
await test('pending and canceled stay pending/canceled (no false promise)', async () => {
  assert.equal((await statusOf('txn_bbbbbbbbbbbbbbbbbbbbbbbbbb')).body.paid, false);
  assert.equal((await statusOf('txn_bbbbbbbbbbbbbbbbbbbbbbbbbb')).body.status, 'pending');
  assert.equal((await statusOf('txn_cccccccccccccccccccccccccc')).body.status, 'canceled');
});
await test('a sandbox payment looked up with live keys explains the mismatch', async () => {
  paddleMode = '404';
  const { status, body } = await statusOf('txn_dddddddddddddddddddddddddd');
  assert.equal(status, 404);
  assert.equal(body.code, 'TRANSACTION_NOT_FOUND');
  assert.match(body.error, /sandbox/i);
  paddleMode = '401';
  const bad = await statusOf('txn_aaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /environment/i);
  paddleMode = 'ok';
});
await test('health advertises the payment capabilities that are on', async () => {
  const res = await handleApi(new Request('https://realm.test/api/health'), payEnv({ SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'sb_test', PADDLE_WEBHOOK_SECRET: 'trl_x' }));
  const body = await res.json();
  assert.equal(body.billing.serverKeyConfigured, true);
  assert.equal(body.billing.activation, 'on');
  const bare = await handleApi(new Request('https://realm.test/api/health'), EMPTY);
  assert.equal((await bare.json()).billing.activation, 'log-only');
});

console.log('\nPaddle webhook → plan activation in Supabase');
const webhook = async (event, env) => {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const res = await handleApi(new Request('https://realm.test/api/paddle/webhook', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};v1=${await sign('whsec_test', ts, body)}` }
  }), env);
  return { status: res.status, body: await res.json() };
};
const sbEnv = (extra = {}) => ({ PADDLE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'sb_test', PADDLE_API_KEY: 'pdl_sdbxTESTKEY', PADDLE_API_BASE: base, RATE_LIMIT_PER_MINUTE: 0, ...extra });
await test('transaction.paid stores the payment and sets the plan by email', async () => {
  sbWrites.length = 0;
  const { status, body } = await webhook({
    event_id: 'evt_10', event_type: 'transaction.paid',
    data: { id: 'txn_aaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'paid', currency_code: 'USD', customer_id: 'ctm_1', updated_at: '2026-09-29T10:00:00.000Z', custom_data: { tier: 'Pro' }, details: { totals: { grand_total: '15.00' } } }
  }, sbEnv());
  assert.equal(status, 200);
  assert.equal(body.activation, 'activate');
  assert.ok(body.actions.some((a) => /^payment:ok/.test(a)), JSON.stringify(body.actions));
  const payment = sbWrites.find((w) => w.route === '/rest/v1/payments');
  assert.equal(payment.method, 'POST');
  assert.equal(payment.row.status, 'paid');
  assert.equal(payment.row.email, 'buyer@example.com', 'customer id is resolved to the email that owns the profile');
  assert.match(payment.prefer, /merge-duplicates/, 'Paddle retries events, so the insert must be idempotent');
  const plan = sbWrites.find((w) => w.route.startsWith('/rest/v1/profiles'));
  assert.equal(plan.method, 'PATCH');
  assert.match(plan.query, /email=eq\./);
  assert.equal(plan.row.plan, 'pro', 'stored lowercase to match profiles.plan');
});
await test('a subscription row is upserted against (provider, provider_ref)', async () => {
  sbWrites.length = 0;
  const { body } = await webhook({
    event_id: 'evt_11', event_type: 'subscription.updated',
    data: { id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { tier: 'starter' }, current_billing_period: { ends_at: '2026-10-29T00:00:00.000Z' }, items: [{ price: { description: 'Realm AI starter (monthly)' } }] }
  }, sbEnv());
  const sub = sbWrites.find((w) => w.route === '/rest/v1/subscriptions');
  assert.equal(sub.method, 'POST');
  assert.match(sub.prefer, /on_conflict=provider,provider_ref/);
  assert.equal(sub.row.plan, 'starter');
  assert.equal(sub.row.current_period_end, '2026-10-29T00:00:00.000Z');
  assert.ok(body.actions.some((a) => /^subscription:ok/.test(a)));
});
await test('a cancellation drops the plan back to free', async () => {
  sbWrites.length = 0;
  await webhook({ event_id: 'evt_12', event_type: 'subscription.canceled', data: { id: 'sub_1', status: 'canceled', customer_id: 'ctm_1', items: [] } }, sbEnv());
  const plan = sbWrites.find((w) => w.route.startsWith('/rest/v1/profiles'));
  assert.equal(plan.row.plan, 'free');
});
await test('the event row is marked processed, and a DB outage never breaks the ack', async () => {
  sbWrites.length = 0;
  const { status, body } = await webhook({ event_id: 'evt_13', event_type: 'transaction.paid', data: { id: 'txn_aaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'paid', details: { totals: { grand_total: '1.00' } } } }, sbEnv());
  assert.equal(status, 200);
  assert.ok(sbWrites.some((w) => w.route.startsWith('/rest/v1/payment_events') && w.method === 'PATCH'), 'processed_at is stamped');
  const offline = await webhook({ event_id: 'evt_14', event_type: 'transaction.paid', data: { id: 'txn_a', status: 'paid' } }, { ...sbEnv(), SUPABASE_URL: 'http://127.0.0.1:1' });
  assert.equal(offline.status, 200, 'Paddle must not retry forever because our database is down');
  assert.ok(offline.body.actions.every((a) => /failed/.test(a)), JSON.stringify(offline.body.actions));
});
await test('WEBHOOK_ACTIVATE=0 keeps verification on but touches no table', async () => {
  sbWrites.length = 0;
  const { body } = await webhook({ event_id: 'evt_15', event_type: 'transaction.paid', data: { id: 'txn_a', status: 'paid' } }, sbEnv({ WEBHOOK_ACTIVATE: '0' }));
  assert.equal(body.activation, 'disabled');
  assert.deepEqual(body.actions, []);
  assert.equal(sbWrites.filter((w) => w.route === '/rest/v1/payments').length, 0);
});

server.close();
console.log(`\n${passed} test group(s) passed${process.exitCode ? ' — with failures' : ''}.\n`);
