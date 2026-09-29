/** Realm AI full-stack Cloudflare Worker.
 *
 * Static website is served through the Workers Static Assets binding.
 * API keys must be stored as Worker secrets, never in public HTML/JS.
 *
 * Secrets expected for AI (when enabled):
 *   GEMINI_API_KEY
 *   GEMINI_MODEL (optional; defaults to gemini-2.5-flash)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders }
  });
}

function cleanMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map(m => ({ role: m.role, content: String(m.content ?? '').slice(0, 20000) }))
    .slice(-30);
}


/** Public Paddle config for the browser. Fails loudly: no defaults for environment or token. */
export function paddleConfig(request, env) {
  const environment = env.PADDLE_ENV, token = env.PADDLE_CLIENT_TOKEN;
  if (!environment) return json({ error: 'PADDLE_ENV is not set (must be "sandbox" or "production").' }, 500);
  if (environment !== 'sandbox' && environment !== 'production') return json({ error: 'PADDLE_ENV must be "sandbox" or "production", got "' + environment + '".' }, 500);
  if (!token) return json({ error: 'PADDLE_CLIENT_TOKEN is not set.' }, 500);
  const want = environment === 'sandbox' ? 'test_' : 'live_';
  if (!token.startsWith(want)) return json({ error: 'PADDLE_CLIENT_TOKEN does not match PADDLE_ENV=' + environment + ' (expected prefix ' + want + ').' }, 500);
  let country = String(request.cf?.country || request.headers.get('CF-IPCountry') || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') country = null; // unknown: omit, Paddle auto-detects
  return json({ environment, clientToken: token, country }, 200, { 'Cache-Control': 'no-store' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // API routes
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, service: 'realm-ai', version: 'v2' });
    }

    if (url.pathname === '/api/paddle-config' && request.method === 'GET') return paddleConfig(request, env);

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const messages = cleanMessages(body?.messages);
        if (!messages.length) return json({ error: 'messages is required' }, 400);

        if (!env.GEMINI_API_KEY) {
          return json({
            error: 'AI is not connected yet.',
            code: 'AI_NOT_CONFIGURED'
          }, 503);
        }

        const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
        const system = messages.find(m => m.role === 'system')?.content ||
          'You are Realm AI, a helpful, accurate, concise AI assistant.';
        const turns = messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: turns,
              generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
            })
          }
        );

        const raw = await response.text();
        if (!response.ok) {
          return new Response(raw, {
            status: response.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
          });
        }

        const data = JSON.parse(raw);
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        return json({ text, model });
      } catch (error) {
        return json({ error: 'Chat request failed', detail: String(error?.message || error) }, 500);
      }
    }

    // Payment is intentionally locked until an approved merchant integration exists.
    if (url.pathname === '/api/payment/jazzcash/create' && request.method === 'POST') {
      return json({
        ready: false,
        provider: 'jazzcash',
        code: 'JAZZCASH_NOT_CONFIGURED',
        message: 'Configure an approved JazzCash Online Payment Gateway merchant account before enabling live checkout.'
      }, 501);
    }

    // Everything else: serve the static frontend.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: 'Static assets binding is not configured.' }, 500);
  }
};
