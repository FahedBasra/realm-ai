/**
 * Netlify Function → /api/*  (see netlify.toml: /api/* is proxied here)
 *
 * Realm AI is built for Cloudflare first (see CLOUDFLARE.md); this file exists so that a Netlify
 * deploy of the same repo is not a dead end: it exposes the exact same routes by reusing
 * shared/api.js, instead of a second copy of the logic that would drift.
 *
 * Netlify v2 functions are mounted at /.netlify/functions/api/<rest>, so the pathname is rewritten
 * back to /api/<rest> before it reaches the dispatcher.
 *
 * Secrets to add in Netlify (Site settings → Environment variables), same names as Cloudflare:
 *   GEMINI_API_KEY, GEMINI_MODEL, PADDLE_ENV, PADDLE_CLIENT_TOKEN, PADDLE_WEBHOOK_SECRET,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RATE_LIMIT_PER_MINUTE
 */
import { handleApi, json } from '../../shared/api.js';

export default async (request, context = {}) => {
  const env = context.env || context.executionContext?.env || {};
  const url = new URL(request.url);
  const rewritten = url.pathname.replace(/^\/(\.netlify\/functions\/)?api/, '/api') + url.search;
  const proxied = new Request(`${url.protocol}//${url.host}${rewritten}`, request);
  const response = await handleApi(proxied, env, context);
  return response || json({ error: 'Route not found.', code: 'ROUTE_NOT_FOUND' }, 404);
};
