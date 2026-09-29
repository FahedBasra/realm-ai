# Realm AI

[![CI](https://github.com/FahedBasra/realm-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/FahedBasra/realm-ai/actions/workflows/ci.yml)

A production-shaped AI assistant: one static frontend (chat, agents, files, code, images, voice) plus a
small serverless backend that talks to Gemini, runs Agent mode step by step, serves Paddle pricing and
verifies payment webhooks.

Your API keys never enter the browser. Everything the page needs comes from `/api/*`.

```
public/            what visitors download (this is the deploy directory)
  index.html        the whole app UI
  tiers.js          ← EDIT THIS: plan names, features, Paddle price IDs
  pricing.js        renders plans, opens Paddle Checkout
  welcome.html      post-payment landing page
  robots.txt sitemap.xml _headers 404.html
shared/api.js      ← ALL backend logic (chat, agent, pricing config, webhook, health, limits)
netlify/           Netlify Function wrapper + netlify.toml (current host)
worker/index.js    Cloudflare Worker entry (serves /api/*, then public/ as static assets)
functions/api/*    Cloudflare Pages Functions (same shared/api.js, same behaviour)
supabase/schema.sql  accounts + chat storage + payment events (RLS enabled)
tests/             npm test — 50 API/agent tests + 52 jsdom UI checks of the real page
scripts/check.mjs  npm run check — deploy-breakage guard (CI runs both)
```

## What is actually wired

| Feature | State |
|---|---|
| Chat | ✅ real — `POST /api/chat` → Gemini, key on the server, history size/length capped, provider errors explained in the UI |
| Agent mode | ✅ real — `POST /api/agent`, one model call per phase (`plan` → `step` ×n → `verify`), live step cards, Stop, copy result, retry the failed step without losing earlier work |
| Pricing | ✅ real but **preview until configured** — Paddle price IDs in `public/tiers.js` + two env vars and it goes live |
| Payment webhooks | ✅ verified (HMAC-SHA256, replay-window checked), events journalled to Supabase when configured. Plan activation waits on user accounts, on purpose |
| Files | 🟡 browser-side text extraction (`.txt .md .csv .json` + code) sent with your next message; PDF/DOCX need server-side parsing (`NEXT_STEPS.md` Sprint D) |
| Image studio | 🟡 uses a public keyless image endpoint, no account needed; server-side generation is a swap in `index.html` |
| Voice input | 🟡 Web Speech API (Chrome/Safari); unsupported browsers get a toast instead of silence |
| Accounts / synced history | ⛔ not built — Supabase schema is ready (`supabase/schema.sql`, RLS on). Sprint B |

## Deploy

Your repo is already connected to **Netlify**, so that's the path of least resistance — free, no build
config to remember (it lives in `netlify.toml`), one env var to get chat working. Full walkthrough:
**[NETLIFY.md](NETLIFY.md)**.

```bash
# Netlify: dashboard → Site configuration → Environment variables → add
GEMINI_API_KEY=<key from https://aistudio.google.com/apikey>   # then redeploy
```

Prefer Cloudflare? Both supported styles are documented in **[CLOUDFLARE.md](CLOUDFLARE.md)** and behave
identically, because all three hosts call the same `shared/api.js`:

| | A · Cloudflare Workers (recommended) | B · Cloudflare Pages |
|---|---|---|
| Command | `npx wrangler login && npm run deploy` | Pages → connect this repo |
| Build command | none needed | `exit 0` |
| Build output directory | n/a (`wrangler.json` → `./public`) | **`public`** — not `/`, not `.` |
| API routes | `worker/index.js` | `functions/api/*.js` (auto-detected) |
| Secrets | `npx wrangler secret put GEMINI_API_KEY` | Settings → Environment variables & Secrets → **redeploy** |

One host must own the API: env vars are per-host, so if Netlify serves the pages and Cloudflare holds the
key, the app correctly reports "backend is not connected". If Netlify's 10-second function ceiling is too
tight for long answers, keep the pages there and point the app at a Worker API instead:
`<meta name="realm:api" content="https://realm-ai.<account>.workers.dev" />` (`CLOUDFLARE.md` §D).

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
npm run dev                        # Cloudflare Worker + static assets  → http://localhost:8787
npm run dev:pages                  # Cloudflare Pages Functions variant → http://localhost:8788
npm test                           # structure check + 51 API tests + 56 jsdom UI checks
npm run dev:mock                   # no API key? chat + agent run against scripts/mock-gemini.mjs
```

## Secrets / env reference

Same names on every host (Netlify → Environment variables; Cloudflare → `wrangler secret put`).

| Name | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes for chat + agent | server-side Gemini key |
| `GEMINI_MODEL` | no | default `gemini-2.5-flash-lite` |
| `GEMINI_MODEL_FALLBACK` | no | retried once when the model name is wrong/unavailable |
| `GEMINI_TEMPERATURE` `GEMINI_MAX_TOKENS` `GEMINI_THINKING_BUDGET` | no | generation tuning |
| `PROVIDER_TIMEOUT_MS` | no | ms before we abort the provider call (Netlify wrapper sets 21000; Cloudflare default 55000) |
| `GEMINI_BASE_URL` `GEMINI_API_VERSION` | no | point at a proxy/gateway, or the local test mock |
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

`public/sitemap.xml`, `public/robots.txt` and the page canonical still contain `YOUR-DOMAIN`
(`npm run check` warns until you replace it). Canonical/og:url are also fixed automatically at runtime from
`location.origin`, so social previews are already correct on whatever host you use.

## Something looks broken?

[TROUBLESHOOTING.md](TROUBLESHOOTING.md) is a symptom → cause → fix table covering Netlify, Cloudflare
Pages, Workers, the AI provider and Paddle. Start with `npm run check` and `/api/health`.
