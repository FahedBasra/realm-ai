/** Cloudflare Pages Function → GET /api/checkout-status?txn=txn_… (live Paddle purchase confirmation). */
import { handleApi } from '../../shared/api.js';

export const onRequest = async ({ request, env }) => (await handleApi(request, env));
