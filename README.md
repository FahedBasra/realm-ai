# Realm AI

[![CI](https://github.com/FahedBasra/realm-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/FahedBasra/realm-ai/actions/workflows/ci.yml)

A production-shaped AI assistant: one static frontend (chat, agents, files, code, images, voice) plus a
small Cloudflare backend that talks to Gemini, serves Paddle pricing and verifies payment webhooks.

Your API keys never enter the browser. Everything the page needs comes from `/api/*`.

```
public/            what visitors download (this is the deploy directory)
  index.html        the whole app UI
  tiers.js          ← EDIT THIS: plan names, features, Paddle price IDs
  pricing.js        renders plans, opens Paddle Checkout
  welcome.html      post-payment landing page
  robots.txt sitemap.xml _headers 404.html
shared/api.js      ← ALL backend logic (chat, pricing config, webhook, health, limits)
worker/index.js    Cloudflare Worker entry (serves /api/*, then public/ as static assets)
functions/api/*    Cloudflare Pages Functions (same shared/api.js, same behaviour)
netlify/*          optional Netlify mirror (netlify.toml + one function); Cloudflare is the main host
wrangler.json      Worker config (assets dir, run_worker_first, compat date)
supabase/schema.sql  accounts + chat storage + payment events (RLS enabled)
tests/             npm test — API logic tests + a jsdom boot test of the real page
scripts/check.mjs  npm run check — deploy-breakage guard (CI runs both)
```

## Deploy on Cloudflare (10 minutes)

Pick **one** of the two — both behave identically because they share `shared/api.js`.
(Heads-up: this repo is *also* wired to a Netlify site called `reralm-ai`. If you keep that, `netlify.toml`
now pins its publish dir to `public` and serves the same API, but set the secrets on whichever host
actually serves your visitors — `A` or `B` — or the app will say "backend not connected" on the other one.)

| | A · Cloudflare Workers (recommended) | B · Cloudflare Pages |
|---|---|---|
| Command | `npx wrangler login && npm run deploy` | Cloudflare dashboard → Workers & Pages → Create → Pages → connect this repo |
| Build command | none needed | `exit 0` |
| Build output directory | n/a (`wrangler.json` says `./public`) | **`public`** — not `/`, not `.` |
| API routes | `worker/index.js` | `functions/api/*.js` (auto-detected) |
| Secrets | `npx wrangler secret put NAME` | Pages → Settings → Variables and Secrets → Add |

Then add the AI key — this is the only secret you *need*:

```bash
npx wrangler secret put GEMINI_API_KEY     # from https://aistudio.google.com/apikey
# optional: npx wrangler secret put GEMINI_MODEL   (default gemini-2.5-flash-lite)
```

For Pages, add the same value in **Settings → Variables and Secrets → Secrets**, then **redeploy**
(secrets are read at build/deploy time; changing one without redeploying changes nothing).

Full click-by-click instructions, custom domain, and the Pages-specific gotchas: [CLOUDFLARE.md](CLOUDFLARE.md).

## Verify it works

```bash
curl https://YOUR-SITE/                       # → the Realm AI HTML, not a 404
curl https://YOUR-SITE/api/health             # → "ai":{"configured":true,...}
curl -X POST https://YOUR-SITE/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say OK"}]}'
```

Or open the site → **Settings**: the "Backend" strip reads `/api/health` and tells you exactly which
secret is missing (AI connected/not, Paddle environment, token match, rate limit). No more guessing.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # put your Gemini key here; .dev.vars is gitignored
npm run dev                        # Worker + static assets  → http://localhost:8787
npm run dev:pages                  # Pages Functions variant → http://localhost:8788
npm test                           # structure check + 37 API tests + 32 jsdom UI checks
```

## Secrets / env reference

Set in Cloudflare (Workers: `wrangler secret put`, Pages: Variables and Secrets). Details in [CLOUDFLARE.md](CLOUDFLARE.md#secrets).

| Name | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes for chat | server-side Gemini key |
| `GEMINI_MODEL` | no | default `gemini-2.5-flash-lite` |
| `GEMINI_MODEL_FALLBACK` | no | retried once if the model name is wrong/unavailable |
| `GEMINI_TEMPERATURE` `GEMINI_MAX_TOKENS` `GEMINI_THINKING_BUDGET` | no | generation tuning |
| `PADDLE_ENV` `PADDLE_CLIENT_TOKEN` | only for billing | `sandbox`/`production` + `test_…`/`live_…` token |
| `PADDLE_WEBHOOK_SECRET` | only for webhooks | verifies `POST /api/paddle/webhook` |
| `SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY` | no | journals payment events (needs `supabase/schema.sql`) |
| `RATE_LIMIT_PER_MINUTE` | no | default `20` per visitor per minute; `0` disables |
| `ALLOWED_ORIGINS` | no | only if another site calls this API (comma-separated) |

## Billing (optional, Paddle)

See [PADDLE.md](PADDLE.md). Short version: put your price IDs in `public/tiers.js`, set `PADDLE_ENV` +
`PADDLE_CLIENT_TOKEN`, point a Paddle notification at `https://YOUR-SITE/api/paddle/webhook`.
Until then the pricing page shows preview plans instead of an error — on purpose.

## Before you tell Google about the site

`public/sitemap.xml`, `public/robots.txt` and the page canonical still contain `YOUR-DOMAIN`.
Replace it with your live domain (`npm run check` reminds you until you do). Canonical/og:url are also
fixed automatically at runtime from `location.origin`, so social previews work even before you edit them.
