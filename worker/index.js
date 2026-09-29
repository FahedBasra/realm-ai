/**
 * Realm AI — Cloudflare Worker entry point.
 *
 * Serves the static frontend through the Workers Static Assets binding
 * (see wrangler.json → assets.directory = ./public) and handles /api/* here.
 *
 * All API keys must live in Worker secrets — never in public HTML/JS:
 *   npx wrangler secret put GEMINI_API_KEY
 */

import { handleApi, json } from '../shared/api.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const api = await handleApi(request, env, ctx);
      if (api) return api;
    } catch (error) {
      // Never leak a stack trace to the browser, but keep enough for debugging.
      console.error('[realm-ai] unhandled error', error?.stack || error);
      return json({ error: 'Unexpected server error.', code: 'INTERNAL' }, 500);
    }

    if (!env.ASSETS) {
      return json(
        { error: 'Static assets binding is not configured. Add assets.directory = "./public" to wrangler.json.', code: 'ASSETS_NOT_CONFIGURED' },
        500
      );
    }
    return env.ASSETS.fetch(request);
  }
};
