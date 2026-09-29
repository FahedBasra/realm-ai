/** Cloudflare Pages Function → GET /api/health (deployment self-check; safe to expose, it contains no secrets). */
import { handleApi } from '../../shared/api.js';

export const onRequest = async ({ request, env }) => (await handleApi(request, env));
