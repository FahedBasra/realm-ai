/** Cloudflare Pages Function → GET /api/paddle-config (public Paddle settings for the pricing page). */
import { handleApi } from '../../shared/api.js';

export const onRequest = async ({ request, env }) => (await handleApi(request, env));
