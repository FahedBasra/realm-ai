#!/usr/bin/env node
/**
 * Offline mock of the Gemini generateContent endpoint.
 *
 * Lets you exercise the whole app — UI → /api/chat, /api/agent, error paths, rate limits — without a key
 * and without spending quota. Only ever used for local development: point the Worker at it with
 * GEMINI_BASE_URL (see .dev.vars.example) and it answers like the real API, including streaming-free
 * JSON shapes, 429s and model-not-found errors.
 *
 *   node scripts/mock-gemini.mjs [port]        # default 9123
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

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (!req.url.endsWith(':generateContent')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 404, message: `mock-gemini only serves :generateContent (got ${req.url})` } }));
    }
    let prompt = '';
    try {
      const parsed = JSON.parse(body || '{}');
      const turns = (parsed.contents || []).map((c) => (c.parts || []).map((pt) => pt.text || '').join('')).join('\n');
      const system = (parsed.systemInstruction?.parts || []).map((pt) => pt.text || '').join('\n');
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

server.listen(port, '127.0.0.1', () => {
  console.log(`mock Gemini listening on http://127.0.0.1:${port}`);
  console.log(`set GEMINI_BASE_URL=http://127.0.0.1:${port} and any non-empty GEMINI_API_KEY in .dev.vars, then: npm run dev`);
});
