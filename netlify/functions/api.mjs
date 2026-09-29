/**
 * Netlify Function → /api/*  (see netlify.toml: /api/* is proxied here)
 *
 * Netlify is the host Realm AI currently ships on (NETLIFY.md); Cloudflare is the alternative
 * (CLOUDFLARE.md). Both call the same shared/api.js, so there is exactly one implementation of
 * chat / agent / pricing / webhook logic to keep correct.
 *
 * Netlify v2 functions are mounted at /.netlify/functions/api/<rest>, so the pathname is rewritten
 * back to /api/<rest> before it reaches the dispatcher.
 *
 * Secrets go in Netlify → Site configuration → Environment variables (same names as Cloudflare
 * would use, so switching hosts is a copy-paste, not a rewrite):
 *   GEMINI_API_KEY, GEMINI_MODEL, PADDLE_ENV, PADDLE_CLIENT_TOKEN, PADDLE_WEBHOOK_SECRET,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RATE_LIMIT_PER_MINUTE
 */
import { handleApi, json } from '../../shared/api.js';
import { collectEnv } from '../../shared/netlify-env.js';

export default async (request, context = {}) => {
  // PROVIDER_TIMEOUT_MS: abort the upstream call before Netlify's 26s hard kill, so the user
  // gets "ask something narrower" instead of "FUNCTION_TIMEOUT".
  const env = { PROVIDER_TIMEOUT_MS: '21000', ...collectEnv(context) };
  const url = new URL(request.url);
  const rewritten = url.pathname.replace(/^\/(\.netlify\/functions\/)?api/, '/api') + url.search;
  const proxied = new Request(`${url.protocol}//${url.host}${rewritten}`, request);
  const response = await handleApi(proxied, env, context);
  return response || json({ error: 'Route not found.', code: 'ROUTE_NOT_FOUND' }, 404);
};
