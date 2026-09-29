/**
 * Cloudflare Pages Function → POST /api/paddle/webhook
 * Paddle notifications are verified with PADDLE_WEBHOOK_SECRET before anything is recorded.
 */
import { handleApi } from '../../../shared/api.js';

export const onRequestPost = async ({ request, env }) => (await handleApi(request, env));
