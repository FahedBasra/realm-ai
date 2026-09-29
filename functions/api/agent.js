/**
 * Cloudflare Pages Function → POST /api/agent
 * Drives Realm Agent one phase per request (plan → step… → verify) so a long run never
 * depends on a single request staying alive. Logic lives in shared/api.js.
 */
import { handleApi, json } from '../../shared/api.js';

export const onRequest = async ({ request, env }) => (await handleApi(request, env)) || json({ error: 'Route not found.', code: 'ROUTE_NOT_FOUND' }, 404);
