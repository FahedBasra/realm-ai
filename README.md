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
  welcome.html      post-payment landing page — confirms the purchase live via /api/checkout-status
  robots.txt sitemap.xml _headers 404.html
shared/api.js      ← ALL backend logic (chat, agent, pricing config, webhook, health, limits)
netlify/           Netlify Function wrapper + netlify.toml (current host)
worker/index.js    Cloudflare Worker entry (serves /api/*, then public/ as static assets)
functions/api/*    Cloudflare Pages Functions (same shared/api.js, same behaviour)
supabase/schema.sql  accounts + chat storage + payment events (RLS enabled)
tests/             npm test — 63 API/agent/payment tests + 24 setup-script checks + 78 jsdom UI checks
scripts/check.mjs  npm run check — deploy-breakage guard (CI runs both)
scripts/setup.mjs  npm run setup — doctor + Gemini key check + Paddle catalog, in one command
```

## What is actually wired

| Feature | State |
|---|---|
| Chat | ✅ real — `POST /api/chat` → Gemini, key on the server, history size/length capped, provider errors explained in the UI |
| Agent mode | ✅ real — `POST /api/agent`, one model call per phase (`plan` → `step` ×n → `verify`), live step cards, Stop, copy result, retry the failed step without losing earlier work |
| Pricing | ✅ real but **preview until configured** — `npm run setup:paddle` creates the products/prices in Paddle and fills `public/tiers.js` for you |
| Checkout confirmation | ✅ real — `/welcome.html?_ptxn=…` asks Paddle (not the browser) what happened via `GET /api/checkout-status`; with no id in the URL it offers a lookup from the receipt |
| Payment webhooks | ✅ verified (HMAC-SHA256, replay-window checked), journalled to Supabase, and **activates the plan** (`subscriptions`, `payments`, `profiles.plan`) once Supabase is configured — there is no user account to attach it to until Sprint B lands |
| Files | 🟡 browser-side text extraction (`.txt .md .csv .json` + code) sent with your next message; PDF/DOCX need server-side parsing (`NEXT_STEPS.md` Sprint D) |
| Image studio | 🟡 uses a public keyless image endpoint, no account needed; server-side generation is a swap in `index.html` |
| Voice input | 🟡 Web Speech API (Chrome/Safari); unsupported browsers get a toast instead of silence |
| Accounts / synced history | ⛔ not built — Supabase schema is ready (`supabase/schema.sql`, RLS on). Sprint B |

## Deploy

Your repo is already connected to **Netlify**, so that's the path of least resistance — free, no build
config to remember (it lives in `netlify.toml`), one env var to get chat working. Full walkthrough:
**[NETLIFY.md](NETLIFY.md)**.

```bash
# One command does the AI side: validates the key, writes .dev.vars, prints the host command
GEMINI_API_KEY=<key from https://aistudio.google.com/apikey> npm run setup:gemini

# Netlify dashboard route: Site configuration → Environment variables → add GEMINI_API_KEY
# (marked "Secret", for Production *and* Deploy previews) → then redeploy
```

`npm run setup` (no arguments) is a doctor: it reads `.dev.vars`, `netlify.toml` and `public/tiers.js` and
tells you which of the launch steps are still open — including the classic Paddle mistake of a sandbox key
next to a live client token. Account creation itself (Paddle sandbox/live, AI Studio, Supabase) is walked
through in [PADDLE.md](PADDLE.md) §0 with the exact URLs and field values.

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
npm test                           # structure check + 63 API tests + 24 setup checks + 78 UI checks
npm run dev:mock                   # no API key? chat + agent run against scripts/mock-gemini.mjs
npm run setup                      # what is still missing before launch (read-only)
npm run setup:paddle               # create the Paddle catalog + fill tiers.js (needs PADDLE_API_KEY)
```

## Secrets / env reference

Same names on every host (Netlify → Environment variables; Cloudflare → `wrangler secret put`).

| Name | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes for chat + agent | server-side Gemini key |
| `GEMINI_MODEL` | no | default `gemini-2.5-flash-lite` |
| `GEMINI_MODEL_FALLBACK` | no | retried once when the model name is wrong/unavailable |
| `GEMINI_TEMPERATURE` `GEMINI_MAX_TOKENS` `GEMINI_THINKING_BUDGET` | no | generation tuning |
| `PROVIDER_TIMEOUT_MS` | no | ms before we abort the provider call (Netlify wrapper sets 8000 to fit the 10s free ceiling; Workers default 55000) |
| `GEMINI_BASE_URL` `GEMINI_API_VERSION` | no | point at a proxy/gateway, or the local test mock |
| `PADDLE_ENV` `PADDLE_CLIENT_TOKEN` | only for billing | `sandbox`/`production` + `test_…`/`live_…` token |
| `PADDLE_API_KEY` | for confirmation + activation | server-side Paddle key (`_sdbx` in sandbox); never sent to the browser |
| `PADDLE_WEBHOOK_SECRET` | only for webhooks | verifies `POST /api/paddle/webhook` |
| `WEBHOOK_ACTIVATE` | no | `0` = verify and log events without touching tables |
| `SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY` | no | payment event journal + plan activation (needs `supabase/schema.sql`) |
| `RATE_LIMIT_PER_MINUTE` | no | default `20` per visitor per minute; `0` disables |
| `ALLOWED_ORIGINS` | no | only if another site calls this API (comma-separated) |

## Billing (optional, Paddle)

See [PADDLE.md](PADDLE.md) — including §0, which walks through creating the sandbox and live accounts (correct
URLs, what each field is for, why a signup fails, test cards). Short version:

```bash
npm run setup:paddle                                   # products + prices created, tiers.js filled for you
npx netlify env:set PADDLE_ENV sandbox && npx netlify env:set PADDLE_CLIENT_TOKEN 'test_…'
# Paddle dashboard → Developer tools → Webhooks → https://YOUR-SITE/api/paddle/webhook → copy trl_… →
npx netlify env:set PADDLE_WEBHOOK_SECRET 'trl_…'      # then redeploy
```

Until the price IDs are real, the pricing page shows preview plans instead of an error — on purpose.

## Before you tell Google about the site

`public/sitemap.xml`, `public/robots.txt` and the page canonical still contain `YOUR-DOMAIN`
(`npm run check` warns until you replace it). Canonical/og:url are also fixed automatically at runtime from
`location.origin`, so social previews are already correct on whatever host you use.

## Something looks broken?

[TROUBLESHOOTING.md](TROUBLESHOOTING.md) is a symptom → cause → fix table covering Netlify, Cloudflare
Pages, Workers, the AI provider and Paddle. Start with `npm run check` and `/api/health`.
