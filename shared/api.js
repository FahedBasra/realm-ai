/**
 * Realm AI — shared API layer.
 *
 * This is the single source of truth for every server route. It is imported by:
 *   - worker/index.js            (Cloudflare Worker + static assets deployment)
 *   - functions/api/*.js         (Cloudflare Pages Functions deployment)
 *
 * So the two deployment styles can never drift apart.
 *
 * Security rules enforced here:
 *   - Provider keys are read from env (Worker/Pages secrets) and never returned to the browser.
 *   - The Gemini key is sent as the x-goog-api-key header, never in a URL (URLs end up in logs).
 *   - Request bodies and history are size-capped so one visitor cannot burn your quota or memory.
 *   - Optional per-IP rate limiting (Cloudflare KV if bound, in-isolate counter otherwise).
 *
 * Env vars (all optional unless noted):
 *   GEMINI_API_KEY            (required for /api/chat) secret
 *   GEMINI_MODEL              default: gemini-2.5-flash-lite
 *   GEMINI_BASE_URL           default: https://generativelanguage.googleapis.com
 *   GEMINI_API_VERSION        default: v1beta
 *   GEMINI_MODEL_FALLBACK     retried once when the primary model returns 404
 *   GEMINI_TEMPERATURE        default: 0.4
 *   GEMINI_MAX_TOKENS         default: 2048
 *   GEMINI_THINKING_BUDGET    optional int; 0 = fastest/cheapest on thinking models
 *   RATE_LIMIT_PER_MINUTE     default: 20 (0 disables)
 *   ALLOWED_ORIGINS           comma separated; only needed if you call the API from another site
 *   PADDLE_ENV                "sandbox" | "production"
 *   PADDLE_CLIENT_TOKEN       Paddle client-side token (test_... or live_...)
 *   PADDLE_PRICE_IDS          optional "month=pri_x,year=pri_y" list, for validating tiers
 *   PADDLE_WEBHOOK_SECRET     shared secret used to verify Paddle notification signatures
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   if set, webhook events are journalled
 */

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 24000;
const PROVIDER_TIMEOUT_MS_DEFAULT = 55000;
const WEBHOOK_MAX_SKEW_SECONDS = 300;

/* ------------------------------------------------------------------ helpers */

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  });
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const trim = (value, max) => String(value ?? '').slice(0, max);

function errorResponse(message, status = 400, code) {
  return json({ error: message, ...(code ? { code } : {}) }, status);
}

function methodNotAllowed(allowed) {
  return errorResponse(`Wrong method. This route accepts ${allowed}.`, 405, 'METHOD_NOT_ALLOWED');
}

function apiNotFound() {
  return errorResponse(
    'Unknown API route. Available: GET /api/health, POST /api/chat, POST /api/agent, GET /api/paddle-config, POST /api/paddle/webhook.',
    404,
    'ROUTE_NOT_FOUND'
  );
}

/** CORS is only emitted for origins explicitly allowed; same-origin needs nothing. */
function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  let sameOrigin = false;
  try {
    sameOrigin = origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return null;
  if (!(allowed.includes('*') || allowed.includes(origin))) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600'
  };
}

/* -------------------------------------------------------------- chat engine */

/** Accepts {messages:[{role,content}]} or {prompt:"..."}; returns a clean Gemini-shaped history. */
export function normalizeMessages(input) {
  let list = Array.isArray(input) ? input : null;
  if (!list && typeof input === 'string' && input.trim()) list = [{ role: 'user', content: input }];
  if (!list) return { error: 'messages (array) or prompt (string) is required.' };

  const out = [];
  for (const m of list) {
    if (!m) continue;
    const role = String(m.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const content = trim(m.content, MAX_MESSAGE_CHARS).trim();
    if (!content) continue;
    out.push({ role, content });
  }
  if (!out.some((m) => m.role === 'user')) return { error: 'No user message to answer.' };
  return { messages: out.slice(-MAX_MESSAGES) };
}

/** Gemini requires a user-first, strictly alternating transcript. */
export function toContents(messages) {
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + m.content;
    else turns.push({ role, parts: [{ text: m.content }] });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export function extractText(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  // parts flagged `thought` are the model's internal reasoning; never shown to users.
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
    .trim();
}

function geminiBody(messages, env, options = {}) {
  const body = {
    contents: toContents(messages),
    generationConfig: {
      temperature: num(env.GEMINI_TEMPERATURE, 0.4),
      maxOutputTokens: Math.max(1, Math.min(8192, num(env.GEMINI_MAX_TOKENS, 2048)))
    }
  };
  const system = messages.find((m) => m.role === 'system')?.content;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  else body.systemInstruction = {
    parts: [{ text: 'You are Realm AI, a helpful, friendly assistant. Reply in English unless the user writes in another language. Be clear and concise.' }]
  };
  if (options.json) body.generationConfig.responseMimeType = 'application/json';
  const budget = env.GEMINI_THINKING_BUDGET;
  if (budget !== undefined && budget !== '') {
    body.generationConfig.thinkingConfig = { thinkingBudget: Math.max(-1, num(budget, 0)) };
  }
  return body;
}

/** Overridable so the same route can talk to a proxy/gateway or a local test server. */
export function geminiEndpoint(env, model) {
  const base = String(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const version = String(env.GEMINI_API_VERSION || 'v1beta').replace(/^\/|\/$/g, '');
  return `${base}/${version}/models/${encodeURIComponent(model)}:generateContent`;
}

async function geminiRequest(body, model, key, env) {
  const controller = new AbortController();
  // Netlify Functions are hard-killed at 26s, so the host wrapper sends a smaller budget;
  // self-limiting lets us answer with a useful "narrow it down" message instead of a platform timeout.
  const budget = Math.max(5000, Math.min(120000, num(env.PROVIDER_TIMEOUT_MS, PROVIDER_TIMEOUT_MS_DEFAULT)));
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await fetch(geminiEndpoint(env, model), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: trim(text, 2000) };
    }
    return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
  } finally {
    clearTimeout(timer);
  }
}

/** Maps provider failures into short, actionable messages for the UI. */
function describeProviderError(status, data, model) {
  const raw = trim(data?.error?.message, 300) || 'The AI provider did not give a reason.';
  if (status === 400 && /API key not valid/i.test(raw)) {
    return { message: 'GEMINI_API_KEY is not valid. Create a key at aistudio.google.com and update the secret.', code: 'BAD_KEY', status: 502 };
  }
  if (status === 403 || (status === 400 && /permission|not enabled/i.test(raw))) {
    return { message: `The AI provider rejected access to "${model}". Enable the Generative Language API for this key.`, code: 'MODEL_FORBIDDEN', status: 502 };
  }
  if (status === 404 || (status === 400 && /not found/i.test(raw))) {
    return { message: `Model "${model}" is not available for this key. Set GEMINI_MODEL to a model you can use (e.g. gemini-2.5-flash-lite).`, code: 'MODEL_NOT_FOUND', status: 502 };
  }
  if (status === 429) {
    return { message: 'The AI provider is rate-limiting us right now. Wait a few seconds and try again.', code: 'PROVIDER_RATE_LIMIT', status: 429 };
  }
  if (status === 400) {
    return { message: `The AI provider rejected the request: ${raw}`, code: 'BAD_REQUEST', status: 400 };
  }
  return { message: `The AI provider failed (HTTP ${status}). Please try again.`, code: 'PROVIDER_ERROR', status: 502 };
}

async function callGemini(messages, env, options = {}) {
  const model = trim(env.GEMINI_MODEL, 80) || DEFAULT_MODEL;
  const body = geminiBody(messages, env, options);
  let attempt = await geminiRequest(body, model, env.GEMINI_API_KEY, env);

  // A mistyped / unavailable model is the most common setup mistake: try the fallback once.
  const fallback = trim(env.GEMINI_MODEL_FALLBACK, 80);
  if ((attempt.status === 404 || (attempt.status === 400 && /not found/i.test(attempt.data?.error?.message || ''))) && fallback && fallback !== model) {
    const retry = await geminiRequest(body, fallback, env.GEMINI_API_KEY, env);
    if (retry.status < 400) return { ...retry, modelUsed: fallback };
    attempt = retry;
  } else if (attempt.status >= 500) {
    await sleep(400);
    attempt = await geminiRequest(body, model, env.GEMINI_API_KEY, env); // one retry for transient blips
  }

  if (attempt.status >= 400) return { ...attempt, modelUsed: model };

  // 200 + non-JSON is what a corporate proxy / Cloudflare error page looks like.
  // Better to fail loudly than to store "I could not generate a reply" as if the model said it.
  if (!Array.isArray(attempt.data?.candidates)) {
    // Sanitised: never echo raw upstream markup back to the browser.
    const snippet = trim(String(attempt.data?.raw || attempt.data?.error?.message || ''), 140).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      status: 502,
      modelUsed: model,
      badReply: `The AI provider returned a reply we could not read${snippet ? `: ${snippet}` : ' (not JSON). A proxy or firewall may be intercepting the request.'}`
    };
  }

  const text = extractText(attempt.data);
  if (!text) {
    const blockReason = attempt.data?.promptFeedback?.blockReason;
    if (blockReason) {
      return {
        status: 200,
        data: {
          text: `I could not answer that — the provider's safety filter blocked it (${blockReason}). Please rephrase.`,
          blocked: true
        }
      };
    }
    const finish = attempt.data?.candidates?.[0]?.finishReason;
    return {
      status: 200,
      data: {
        text:
          finish === 'MAX_TOKENS'
            ? 'My answer was cut off by the token limit. Ask me something shorter, or raise GEMINI_MAX_TOKENS.'
            : 'I could not generate a reply. Please try again.',
        finishReason: finish || null
      }
    };
  }
  return { status: 200, data: { text, finishReason: attempt.data?.candidates?.[0]?.finishReason || null } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- rate limits */

const localBucket = new Map();

function localLimit(ip, limit, windowMs) {
  const now = Date.now();
  const slot = Math.floor(now / windowMs);
  const entry = localBucket.get(ip);
  if (!entry || entry.slot !== slot) {
    localBucket.set(ip, { slot, count: 1 });
    if (localBucket.size > 5000) {
      for (const [k, v] of localBucket) if (v.slot !== slot) localBucket.delete(k);
    }
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

async function enforceRateLimit(request, env) {
  const limit = num(env.RATE_LIMIT_PER_MINUTE, 20);
  if (!(limit > 0)) return null; // explicitly disabled
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'local';
  const windowMs = 60000;
  if (env.RATE_LIMIT_KV) {
    const key = `rl:${ip}:${Math.floor(Date.now() / windowMs)}`;
    try {
      const current = Number((await env.RATE_LIMIT_KV.get(key)) || 0);
      if (current >= limit) {
        return json({ error: 'Too many requests from your network. Wait a minute and try again.', code: 'RATE_LIMITED' }, 429, { 'retry-after': '60' });
      }
      await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 120 });
      return null;
    } catch {
      // KV problems must never take the chat down; fall through to the local counter.
    }
  }
  if (localLimit(ip, limit, windowMs) > limit) {
    return json({ error: 'Too many requests from your network. Wait a minute and try again.', code: 'RATE_LIMITED' }, 429, { 'retry-after': '60' });
  }
  return null;
}

/* ------------------------------------------------------------------ routes */

/** Common preconditions for anything that costs a provider call. */
async function guardPaidRoute(request, env) {
  if (!env.GEMINI_API_KEY) {
    return json(
      {
        error: 'AI is not connected yet. Add GEMINI_API_KEY as a secret in Cloudflare (or Netlify env vars) and redeploy.',
        code: 'AI_NOT_CONFIGURED'
      },
      503
    );
  }
  const limited = await enforceRateLimit(request, env);
  if (limited) return limited;
  return null;
}

async function handleChat(request, env) {
  const blocked = await guardPaidRoute(request, env);
  if (blocked) return blocked;

  let raw;
  try {
    raw = await request.text();
  } catch {
    return errorResponse('Could not read the request body.', 400);
  }
  if (raw.length > MAX_BODY_BYTES) return errorResponse('Request is too large. Send a shorter conversation.', 413, 'BODY_TOO_LARGE');

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return errorResponse('Body must be valid JSON.', 400, 'BAD_JSON');
  }

  const { messages, error } = normalizeMessages(payload.messages ?? payload.prompt);
  if (error) return errorResponse(error, 400, 'BAD_MESSAGES');

  let result;
  try {
    result = await callGemini(messages, env);
  } catch (err) {
    const detail = String(err?.message || err || '');
    if (/abort/i.test(detail)) {
      return errorResponse('The model took too long to answer. Ask something narrower, or lower GEMINI_MAX_TOKENS.', 504, 'PROVIDER_TIMEOUT');
    }
    return errorResponse('Could not reach the AI provider. Check your network/provider status and try again.', 502, 'PROVIDER_UNREACHABLE');
  }

  if (result.badReply) return json({ error: result.badReply, code: 'BAD_PROVIDER_REPLY', model: result.modelUsed || null }, 502);

  if (result.status >= 400) {
    const described = describeProviderError(result.status, result.data, result.modelUsed || trim(env.GEMINI_MODEL, 80) || DEFAULT_MODEL);
    return json({ error: described.message, code: described.code, model: result.modelUsed || null }, described.status);
  }
  return json({ ...result.data, model: result.modelUsed || trim(env.GEMINI_MODEL, 80) || DEFAULT_MODEL });
}

function handleHealth(env) {
  const paddleEnv = String(env.PADDLE_ENV || '').trim();
  const token = String(env.PADDLE_CLIENT_TOKEN || '').trim();
  const paddleReady = paddleEnv === 'sandbox' || paddleEnv === 'production';
  return json({
    ok: true,
    service: 'realm-ai',
    version: 'v3',
    ai: { configured: Boolean(env.GEMINI_API_KEY), model: trim(env.GEMINI_MODEL, 80) || DEFAULT_MODEL },
    billing: {
      paddleConfigured: paddleReady && Boolean(token),
      environment: paddleEnv || null,
      tokenMatchesEnv: paddleReady ? token.startsWith(paddleEnv === 'sandbox' ? 'test_' : 'live_') : false,
      webhookConfigured: Boolean(env.PADDLE_WEBHOOK_SECRET),
      eventLogConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
    },
    limits: { requestsPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 20) || 'disabled' },
    storage: { assets: 'static' }
  });
}

/** Public Paddle config for the browser. Fails loudly: no defaults for environment or token. */
function handlePaddleConfig(request, env) {
  const environment = String(env.PADDLE_ENV || '').trim();
  const token = String(env.PADDLE_CLIENT_TOKEN || '').trim();
  if (!environment || !token) {
    return json(
      {
        error: 'Billing is not configured yet. Set PADDLE_ENV and PADDLE_CLIENT_TOKEN as secrets.',
        code: 'PADDLE_NOT_CONFIGURED'
      },
      503
    );
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    return json({ error: `PADDLE_ENV must be "sandbox" or "production", got "${environment}".`, code: 'PADDLE_ENV_INVALID' }, 500);
  }
  const want = environment === 'sandbox' ? 'test_' : 'live_';
  if (!token.startsWith(want)) {
    return json(
      { error: `PADDLE_CLIENT_TOKEN does not match PADDLE_ENV=${environment} (expected a token starting with "${want}").`, code: 'PADDLE_TOKEN_MISMATCH' },
      500
    );
  }

  // Visitor country keeps the price on the page equal to the price in checkout.
  let country = String(request.cf?.country || request.headers.get('cf-ipcountry') || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') country = null; // unknown → let Paddle detect

  return json({ environment, clientToken: token, country });
}

/* --------------------------------------------------------- Paddle webhooks */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verifies Paddle's `Paddle-Signature: ts=..;v1=..` header (HMAC-SHA256 over "ts:body"). */
export async function verifyPaddleSignature(request, secret) {
  const header = request.headers.get('paddle-signature') || '';
  const parts = Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
      })
  );
  const ts = Number(parts.ts);
  const signatures = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!ts || !signatures.length || !Number.isFinite(ts)) return { ok: false, reason: 'malformed header' };
  if (Math.abs(Date.now() / 1000 - ts) > WEBHOOK_MAX_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside the accepted window' };
  const body = await request.clone().text();
  const expected = await hmacHex(secret, `${ts}:${body}`);
  const ok = signatures.some((s) => timingSafeEqual(expected, s.toLowerCase()));
  return ok ? { ok: true, event: safeParse(body) } : { ok: false, reason: 'signature mismatch' };
}

const safeParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function logPaymentEvent(env, event) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !event?.event_id) return 'skipped';
  const row = {
    event_id: event.event_id,
    event_type: event.event_type || null,
    occurred_at: event.occurred_at || null,
    payload: event,
    received_at: new Date().toISOString()
  };
  try {
    const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/payment_events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        prefer: 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify(row)
    });
    if (res.ok || res.status === 409) return 'stored';
    return `rejected (${res.status})`;
  } catch (err) {
    return `failed (${String(err?.message || err)})`;
  }
}

async function handlePaddleWebhook(request, env) {
  const secret = String(env.PADDLE_WEBHOOK_SECRET || '').trim();
  if (!secret) return json({ error: 'PADDLE_WEBHOOK_SECRET is not set; cannot verify webhooks.', code: 'WEBHOOK_NOT_CONFIGURED' }, 503);

  const verified = await verifyPaddleSignature(request, secret);
  if (!verified.ok) return json({ error: `Invalid webhook signature: ${verified.reason}.`, code: 'BAD_SIGNATURE' }, 401);
  if (!verified.event) return json({ error: 'Webhook body is not JSON.', code: 'BAD_PAYLOAD' }, 400);

  const event = verified.event;
  const stored = await logPaymentEvent(env, event);

  // Subscription activation needs user accounts (Supabase Auth), which is Sprint C in NEXT_STEPS.md.
  // Until then this endpoint only verifies + journals, so nothing is ever marked "paid" by mistake.
  return json({ received: true, event_id: event.event_id || null, event_type: event.event_type || null, event_log: stored });
}


/* --------------------------------------------------------- agent runner */

/**
 * Agent mode is deliberately *client-driven and resumable*: each phase is its own request
 * (plan → step 0 → step 1 → … → verify) so that one request is always one model call.
 * That keeps every call inside the 26s Netlify ceiling and inside a Cloudflare Worker's
 * budget, shows real progress in the UI, and lets a visitor stop or retry a single step
 * instead of losing a two-minute run. No server-side job storage is needed either.
 */
const AGENT_MAX_STEPS = 6;
const AGENT_STEP_CHARS = 3000;
const AGENT_OUTPUT_CHARS = 4000;

const AGENT_SYSTEM = 'You are Realm Agent, a careful work engine inside the Realm AI workspace. You only ever do the single piece of work you were asked for, and you never invent facts, files, URLs or numbers. When you are unsure, say what is missing instead of guessing.';

/** Models emit raw newlines/tabs inside JSON string values surprisingly often; that is invalid JSON. */
function escapeControlCharsInsideStrings(input) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code === 10) { out += '\\n'; continue; }
    if (code === 13) { continue; }
    if (code === 9) { out += '\\t'; continue; }
    if (code < 0x20) continue;
    out += ch;
  }
  return out;
}

/** LLMs wrapping JSON in prose is common; grab the outermost object. */
export function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidates = [cleaned];
  if (start > -1 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
    try {
      return JSON.parse(escapeControlCharsInsideStrings(candidate));
    } catch {}
  }
  return null;
}

function agentPrompt(phase, payload) {
  const goal = trim(payload.goal, 2000).trim();
  if (!goal) return null;
  if (phase === 'plan') {
    return {
      system: `${AGENT_SYSTEM}
Plan the work for the goal below as 2-${AGENT_MAX_STEPS} sequential steps. Each step must be independently doable in one reply, and the last step must produce the deliverable.
Answer with JSON only, exactly this shape:
{"steps":[{"title":"short imperative","detail":"what the finished step must contain"}],"deliverable":"one line describing the final output","missing":"empty string, or what you need from the user first"}`,
      user: `Goal: ${goal}` + (payload.context ? `\n\nContext from the user:\n${trim(payload.context, 4000)}` : '')
    };
  }
  if (phase === 'step') {
    const index = Math.max(0, Number(payload.stepIndex) || 0);
    const step = (payload.steps || [])[index];
    if (!step || !String(step.title).trim()) return null;
    const done = (payload.outputs || []).slice(0, index).map((o, i) => `### Step ${i + 1}: ${trim((payload.steps?.[i]?.title || ''), 120)}\n${trim(o, AGENT_OUTPUT_CHARS)}`).join('\n\n');
    return {
      system: `${AGENT_SYSTEM}
You are executing ONE step of a plan. Use the earlier steps' results below as your only working memory. Be concrete and produce the actual work, not a description of it. Keep it under ${AGENT_STEP_CHARS} characters.`,
      user: `Goal: ${goal}\nDeliverable: ${trim(payload.deliverable, 300)}\n\n${done ? `Earlier steps:\n${done}\n` : ''}\nNow do step ${index + 1} of ${(payload.steps || []).length}: ${String(step.title).slice(0, 200)}\nRequirement: ${String(step.detail || '').slice(0, 400)}`
    };
  }
  if (phase === 'verify') {
    const outputs = (payload.outputs || []).map((o, i) => `### Step ${i + 1}: ${trim((payload.steps?.[i]?.title || ''), 120)}\n${trim(o, AGENT_OUTPUT_CHARS)}`).join('\n\n');
    return {
      system: `${AGENT_SYSTEM}
Check whether the steps below actually answer the goal, then write the final deliverable by combining them. Do not repeat the step log.
Answer with JSON only, exactly this shape:
{"verdict":"complete" or "incomplete","gaps":["short gap, or empty"],"final":"the deliverable, formatted in markdown for a chat bubble"}
If you cannot produce valid JSON, answer with the markdown only.`,
      user: `Goal: ${goal}\nDeliverable: ${trim(payload.deliverable, 300)}\n\n${outputs || '(no steps were run)'}`
    };
  }
  return null;
}

async function runAgentPhase(request, env) {
  const blocked = await guardPaidRoute(request, env);
  if (blocked) return blocked;

  let raw;
  try {
    raw = await request.text();
  } catch {
    return errorResponse('Could not read the request body.', 400, 'BAD_BODY');
  }
  if (raw.length > MAX_BODY_BYTES) return errorResponse('The run is too large; drop some step results and retry.', 413, 'BODY_TOO_LARGE');

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return errorResponse('Body must be valid JSON.', 400, 'BAD_JSON');
  }
  const phase = String(payload?.phase || 'plan');
  if (!['plan', 'step', 'verify'].includes(phase)) return errorResponse('phase must be "plan", "step" or "verify".', 400, 'BAD_PHASE');

  const prompt = agentPrompt(phase, { goal: payload?.goal, context: payload?.context, steps: payload?.steps, deliverable: payload?.deliverable, outputs: payload?.outputs, stepIndex: payload?.stepIndex });
  if (!prompt) return errorResponse(phase === 'step' ? 'stepIndex is outside the plan.' : 'goal is required.', phase === 'step' ? 400 : 400, 'BAD_AGENT_REQUEST');

  const messages = [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }];
  const result = await callGemini(messages, { ...env, GEMINI_MAX_TOKENS: env.GEMINI_MAX_TOKENS || 1500 }, { json: phase === 'plan' });
  if (result.badReply) return json({ error: result.badReply, code: 'BAD_PROVIDER_REPLY' }, 502);
  if (result.status >= 400) {
    const d = describeProviderError(result.status, result.data, result.modelUsed || trim(env.GEMINI_MODEL, 80) || DEFAULT_MODEL);
    return json({ error: d.message, code: d.code, model: result.modelUsed || null }, d.status);
  }

  const text = result.data?.text || '';
  if (phase === 'plan') {
    const parsed = parseJsonObject(text);
    const steps = Array.isArray(parsed?.steps)
      ? parsed.steps
          .map((s, i) => ({ id: i, title: trim(s?.title, 160).trim(), detail: trim(s?.detail, 600).trim() }))
          .filter((s) => s.title)
          .slice(0, AGENT_MAX_STEPS)
      : [];
    if (!steps.length) {
      // The model ignored the JSON contract: still give the user a usable single-step run.
      return json({ phase, steps: [{ id: 0, title: 'Work on the goal', detail: trim(text, AGENT_STEP_CHARS) }], deliverable: trim(parsed?.deliverable, 300) || 'A written answer', fallback: true });
    }
    return json({ phase, steps, deliverable: trim(parsed?.deliverable, 300) || 'A written answer', missing: trim(parsed?.missing, 300) || '' });
  }
  if (phase === 'step') {
    return json({ phase, index: Math.max(0, Number(payload.stepIndex) || 0), output: trim(text, AGENT_OUTPUT_CHARS * 2) });
  }
  const parsed = parseJsonObject(text);
  if (parsed && typeof parsed === 'object' && (parsed.final || parsed.verdict)) {
    return json({
      phase,
      verdict: parsed.verdict === 'complete' ? 'complete' : 'incomplete',
      gaps: (Array.isArray(parsed.gaps) ? parsed.gaps : []).map((g) => trim(g, 300)).filter(Boolean).slice(0, 6),
      final: trim(parsed.final || text, AGENT_OUTPUT_CHARS * 3)
    });
  }
  return json({ phase, verdict: 'complete', gaps: [], final: trim(text, AGENT_OUTPUT_CHARS * 3), fallback: true });
}

/* ---------------------------------------------------------------- dispatcher */

/**
 * @param {Request} request
 * @param {object} env  Worker/Pages bindings
 * @returns {Promise<Response|null>} null when the path is not an API route (caller serves static assets)
 */
export async function handleApi(request, env) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse('Bad request URL.', 400);
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!path.startsWith('/api/')) return null;

  const cors = corsHeaders(request, env);
  let response;
  if (request.method === 'OPTIONS') {
    response = cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 204 });
  } else if (path === '/api/health') {
    response = request.method === 'GET' || request.method === 'HEAD' ? handleHealth(env) : methodNotAllowed('GET');
  } else if (path === '/api/agent') {
    response = request.method === 'POST' ? await runAgentPhase(request, env) : methodNotAllowed('POST');
  } else if (path === '/api/chat') {
    response = request.method === 'POST' ? await handleChat(request, env) : methodNotAllowed('POST');
  } else if (path === '/api/paddle-config') {
    response = request.method === 'GET' || request.method === 'HEAD' ? handlePaddleConfig(request, env) : methodNotAllowed('GET');
  } else if (path === '/api/paddle/webhook') {
    response = request.method === 'POST' ? await handlePaddleWebhook(request, env) : methodNotAllowed('POST');
  } else {
    response = apiNotFound();
  }

  if (cors && response) {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

export const ROUTES = ['/api/health', '/api/chat', '/api/agent', '/api/paddle-config', '/api/paddle/webhook'];

/** Everything the app reads from the platform. Wrappers use this list because some runtimes
 *  (Netlify v2 in particular) expose env through a getter API instead of a plain object. */
export const ENV_KEYS = [
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_MODEL_FALLBACK', 'GEMINI_TEMPERATURE', 'GEMINI_MAX_TOKENS',
  'GEMINI_THINKING_BUDGET', 'GEMINI_BASE_URL', 'GEMINI_API_VERSION', 'PROVIDER_TIMEOUT_MS',
  'PADDLE_ENV', 'PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RATE_LIMIT_PER_MINUTE', 'ALLOWED_ORIGINS'
];
export { DEFAULT_MODEL };
