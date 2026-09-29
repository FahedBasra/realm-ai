/**
 * Cloudflare Pages Function → POST /api/chat
 * Thin wrapper: all logic lives in shared/api.js so Pages and the Worker behave identically.
 * Pages project settings → Environment variables & Secrets: GEMINI_API_KEY (secret), GEMINI_MODEL (optional).
 */
import { handleApi, json } from '../../shared/api.js';

export const onRequest = async ({ request, env }) => (await handleApi(request, env)) || json({ error: 'Route not found.', code: 'ROUTE_NOT_FOUND' }, 404);
