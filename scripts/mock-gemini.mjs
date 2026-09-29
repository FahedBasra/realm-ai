#!/usr/bin/env node
/**
 * Offline mock of the outside services Realm AI talks to: Gemini, Paddle's API, Supabase's REST API.
 *
 * Lets you exercise the whole app — UI → /api/chat, /api/agent, error paths, rate limits — without a key
 * and without spending quota. Only ever used for local development: point the Worker at it with
 * GEMINI_BASE_URL (see .dev.vars.example) and it answers like the real API, including streaming-free
 * JSON shapes, 429s and model-not-found errors.
 *
 *   node scripts/mock-gemini.mjs [port]        # default 9123
 *
 * It also mocks just enough of Paddle (POST /products, POST /prices, GET /transactions/:id,
 * GET /customers/:id) for `node scripts/setup.mjs paddle --base http://127.0.0.1:<port>`, and enough of
 * Supabase PostgREST (/rest/v1/…) so the webhook's plan activation can be watched locally.
 *
 * Special prompts trigger special behaviour:
 *   "mock:429"      → provider rate limit          "mock:blocked" → safety block
 *   "mock:empty"    → no candidates                "mock:slow"    → 12s stall (shows the timeout path)
 *   "mock:garbage"  → HTML instead of JSON         "mock:500"     → upstream error
 */
import http from 'node:http';

const port = Number(process.argv[2] || process.env.PORT || 9123);

const text = (t, extra = {}) => ({
  candidates: [{ content: { parts: [{ text: t }], role: 'model' }, finishReason: 'STOP', ...extra }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 },
  modelVersion: 'gemini-2.5-flash-lite-mock'
});

function reply(prompt) {
  if (/mock:429/.test(prompt)) return { status: 429, body: { error: { code: 429, message: 'Resource has been exhausted (quota).' } }, headers: { 'retry-after': '17' } };
  if (/mock:500/.test(prompt)) return { status: 500, body: { error: { code: 500, message: 'Internal error encountered.' } } };
  if (/mock:blocked/.test(prompt)) return { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] } };
  if (/mock:empty/.test(prompt)) return { status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] } };
  if (/mock:garbage/.test(prompt)) return { status: 200, raw: '<html><body>502 Bad Gateway from proxy</body></html>', type: 'text/html' };

  // Agent phases: imitate the contract in shared/api.js so the UI can be driven end to end.
  if (/Answer with JSON only.*\{?"steps"/s.test(prompt)) {
    return {
      status: 200,
      body: text(JSON.stringify({
        steps: [
          { title: 'Collect what matters', detail: 'List the constraints and the one number the plan hinges on.' },
          { title: 'Draft the answer', detail: 'Produce the actual deliverable, structured with headings.' },
          { title: 'Sanity-check it', detail: 'Point out the two weakest assumptions.' }
        ],
        deliverable: 'A short, usable answer in markdown',
        missing: ''
      }))
    };
  }
  if (/Check whether the steps below actually answer the goal/.test(prompt)) {
    return {
      status: 200,
      body: text(JSON.stringify({
        verdict: 'complete',
        gaps: [],
        final: '# Result (from the mock)\n\nThis answer was assembled from the step outputs.\n\n**Nothing here is real — you are looking at scripts/mock-gemini.mjs.**'
      }))
    };
  }
  if (/Now do step \d+ of \d+/.test(prompt)) {
    const n = (prompt.match(/Now do step (\d+)/) || [])[1] || '?';
    return { status: 200, body: text(`Step ${n} output from the mock provider: concrete work product for this step, kept short so the demo stays fast.`) };
  }
  return { status: 200, body: text('Mock reply: the API path works end to end. Set a real GEMINI_API_KEY (or GEMINI_BASE_URL off this mock) for actual answers.') };
}

/* --------------------------------------------------- fake Paddle + Supabase */

const id = (prefix) => prefix + Array.from({ length: 26 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const products = new Map();
const prices = new Map();
const writes = [];   // Supabase rows the webhook activation tried to write (printed on request)

const PADDLE_MODEL = [
  { id: 'pro_2mock000000000000000000aa', price_id: 'pri_2mock000000000000000000mo', tier: 'pro', cycle: 'month', status: 'paid', amount: 1200, customer_id: 'ctm_2mock00000000000000000001' },
  { id: 'txn_2pending00000000000000000a', price_id: 'pri_2mock000000000000000000mo', tier: 'pro', cycle: 'month', status: 'pending', amount: 1200, customer_id: 'ctm_2mock00000000000000000001' },
  { id: 'txn_2canceled0000000000000000a', price_id: 'pri_2mock000000000000000000mo', tier: 'pro', cycle: 'month', status: 'canceled', amount: 1200, customer_id: 'ctm_2mock00000000000000000001' }
];

function paddleTxn(txnId) {
  const known = PADDLE_MODEL.find((t) => txnId.startsWith(t.id.slice(0, 8))) || PADDLE_MODEL[0];
  const status = /cancel/.test(txnId) ? 'canceled' : /pending/.test(txnId) ? 'pending' : 'paid';
  return {
    id: txnId,
    status,
    currency_code: 'USD',
    subtotal: String(known.amount / 100),
    custom_data: { tier: known.tier, billing: known.cycle },
    customer_id: known.customer_id,
    subscription_id: status === 'paid' ? 'sub_2mock0000000000000000000a' : null,
    updated_at: '2026-09-29T10:00:00.000Z',
    status_url: `https://www.paddle.com/receipts/${txnId}`,
    invoice: status === 'paid' ? { id: 'inv_2mock000000000000000000a', url: `https://paddle.com/invoices/${txnId}.pdf` } : null,
    details: { totals: { grand_total: String(known.amount / 100), subtotal: String(known.amount / 100), tax: '0.00' } },
    items: [{ price: { id: known.price_id, description: `Realm AI ${known.tier} (${known.cycle}ly)`, product_id: known.id ? 'pro_2mock000000000000000000aa' : null }, quantity: 1 }]
  };
}

function handlePaddle(req, url, body, res) {
  const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/mock/paddle/last') return send(200, { products: [...products.values()], prices: [...prices.values()], supabaseWrites: writes });
  if (!/^pdl_/.test(key)) return send(401, { error: { code: 'unauthorized', message: 'Paddle mock expects an "Authorization: Bearer pdl_…" key (use --key / PADDLE_API_KEY).' } });

  if (req.method === 'POST' && url.pathname === '/products') {
    if (!body?.name) return send(400, { error: { code: 'bad_request', message: 'name is required', details: [{ field: 'name', message: 'required' }] } });
    if (!body?.tax_category) return send(400, { error: { code: 'bad_request', message: 'tax_category is required', details: [{ field: 'tax_category', message: 'one of digital-goods, saas, software-programming-services, …' }] } });
    const made = { id: id('pro_'), ...body };
    products.set(made.id, made);
    return send(201, { data: made });
  }
  if (req.method === 'POST' && url.pathname === '/prices') {
    const err = [];
    if (!body?.product_id || !products.has(body.product_id)) err.push({ field: 'product_id', message: 'unknown product' });
    if (!body?.description || body.description.length < 2) err.push({ field: 'description', message: 'must be 2-500 characters' });
    if (body?.unit_price && !/^\d+$/.test(String(body.unit_price.amount))) err.push({ field: 'unit_price.amount', message: 'must be a string of integer minor units' });
    if (body?.unit_price && body.unit_price.currency_code === 'PKR') err.push({ field: 'unit_price.currency_code', message: 'PKR is not a supported Paddle currency' });
    if (err.length) return send(400, { error: { code: 'bad_request', message: 'validation failed', details: err } });
    const made = { id: id('pri_'), ...body, product_id: body.product_id };
    prices.set(made.id, made);
    return send(201, { data: made });
  }
  const txn = /^\/transactions\/([\w-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && txn) {
    if (/^txn_notfound/.test(txn[1])) return send(404, { error: { code: 'not_found', message: 'Transaction not found in this environment' } });
    return send(200, { data: paddleTxn(txn[1]) });
  }
  const customer = /^\/customers\/([\w-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && customer) {
    return send(200, { data: { id: customer[1], email: 'buyer@example.com', custom_data: { realm: 'local-mock' } } });
  }
  return send(404, { error: { code: 'not_found', message: `Paddle mock does not serve ${req.method} ${url.pathname}` } });
}

function handleSupabase(url, body, res) {
  writes.push({ method: res.__method, path: url.pathname, row: body });
  res.writeHead(res.__method === 'POST' ? 201 : 204, { 'content-type': 'application/json', 'content-range': '0-0/*' });
  res.end(res.__method === 'POST' ? JSON.stringify([body]) : '');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    res.__method = req.method;
    const parsed = (() => { try { return JSON.parse(body || 'null'); } catch { return null; } })();

    if (url.pathname === '/v1beta/models' || url.pathname.endsWith('/models')) {
      const key = url.searchParams.get('key') || '';
      if (!/^AIza/.test(key)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Pass a key that starts with "AIza".' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: MODELS.map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) }));
    }
    if (url.pathname.startsWith('/rest/v1/')) return handleSupabase(url, parsed, res);
    if (!url.pathname.includes(':generateContent')) return handlePaddle(req, url, parsed, res);

    let prompt = '';
    try {
      const parsedGem = JSON.parse(body || '{}');
      const turns = (parsedGem.contents || []).map((c) => (c.parts || []).map((pt) => pt.text || '').join('')).join('\n');
      const system = (parsedGem.systemInstruction?.parts || []).map((pt) => pt.text || '').join('\n');
      prompt = `${system}\n${turns}`;
    } catch {}
    if (/mock:slow/.test(prompt)) await new Promise((r) => setTimeout(r, 12000));
    const r = reply(prompt);
    const payload = r.raw ?? JSON.stringify(r.body);
    res.writeHead(r.status, { 'content-type': r.type || 'application/json', ...(r.headers || {}) });
    res.end(payload);
    console.log(`${new Date().toISOString().slice(11, 19)}  ${r.status}  ${prompt.replace(/\s+/g, ' ').slice(0, 90)}`);
  });
});

const MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];

server.listen(port, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${port}  (Gemini + Paddle + Supabase REST)`);
  console.log(`Gemini: set GEMINI_BASE_URL=http://127.0.0.1:${port} and any non-empty GEMINI_API_KEY in .dev.vars, then: npm run dev`);
  console.log(`Paddle: node scripts/setup.mjs paddle --base http://127.0.0.1:${port} --key pdl_sdbxMOCK`);
});
