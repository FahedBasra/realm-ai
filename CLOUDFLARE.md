# Deploying Realm AI on Cloudflare

Realm AI needs two things from Cloudflare: **static hosting** for `public/` and **a tiny API** for
`/api/chat`, `/api/paddle-config`, `/api/paddle/webhook`, `/api/health`. Both supported setups provide those two,
and both run the *same* code (`shared/api.js`) — so you can switch later without touching the frontend.

> **Why your earlier deploy probably looked broken:** the site file was named `index (2).html`
> (a saved-browser-download name). Cloudflare serves `public/index.html` at `/`, and a file with a
> space + parentheses in it is only reachable at that exact ugly URL — so the root 404'd. The chat
> API also 404'd because `chat.js` sat at the repo root, and Pages Functions only run from `functions/`.
> Both are fixed in this structure; the rest of this file is about the dashboard side.

## A · Workers + Static Assets (recommended)

One Worker serves the assets *and* the API. No build step, no separate project, and
`run_worker_first: ["/api/*"]` means only API requests pay Worker invocations.

### With the CLI (fastest)

```bash
npm install
npx wrangler login                       # opens the Cloudflare consent page in your browser
npx wrangler secret put GEMINI_API_KEY   # paste the key from aistudio.google.com/apikey
npm run dry-run                          # validates wrangler.json + bundles, deploys nothing
npm run deploy                           # → https://realm-ai.<your-account>.workers.dev
```

`wrangler.json` is the source of truth. Do not put secrets in it — it is a public file:

```jsonc
{
  "name": "realm-ai",
  "main": "worker/index.js",
  "compatibility_date": "2026-09-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",   // /welcome → welcome.html
    "not_found_handling": "404-page",         // /nope → public/404.html
    "run_worker_first": ["/api/*"]            // the API needs the Worker; assets don't
  }
}
```

### With GitHub (auto-deploy on every push to `main`)

1. Cloudflare dashboard → **Workers & Pages → Create → Worker → Get started** → name it `realm-ai`, deploy once.
2. Open the Worker → **Settings → Build settings → Connect to Git (Set up Builds)**.
   - Production branch: `main`
   - Root directory: `/`
   - Build command: `npm ci && npm run check` *(the check fails loudly on a broken structure)*
   - Deploy command: `npx wrangler deploy`
3. **Variables** tab → add `CLOUDFLARE_API_TOKEN` (create at My Profile → API Tokens → *Edit Cloudflare Workers* template) — that's what lets CI deploy.
4. Add `GEMINI_API_KEY` as a **secret** variable, then push.

### Optional: a KV namespace for exact rate limiting

The built-in limiter falls back to a per-isolate counter (good enough for one hobby app). For an
account-wide counter, create a KV namespace, add it as `RATE_LIMIT_KV` and set the budget:

```bash
npx wrangler kv namespace create RATE_LIMIT        # note the id it prints
# then in wrangler.json:
#   "kv_namespaces": [{ "binding": "RATE_LIMIT_KV", "id": "<id>" }]
```

## B · Cloudflare Pages (if you already have a Pages project)

1. **Workers & Pages → Create → Pages → Connect to Git** → `FahedBasra/realm-ai`.
2. Framework preset: **None**. Build command: **`exit 0`** (or leave blank).
3. **Build output directory: `public`** ← the setting that matters.
   If it says `/` or `.`, change it (Settings → Build & deployments → Build output root) and redeploy;
   with `/` you also publish `node_modules`-free source, but more importantly the previous broken
   config is what produced the blank/404 site.
4. Settings → **Environment variables & Secrets → Add (Production)**:
   `GEMINI_API_KEY` (Secret type). Add it to **Preview** too if you want PR previews to chat.
5. Redeploy (recent deployment → **Retry deployment**). Secrets are baked in at deploy time —
   adding one without redeploying changes nothing.

Notes that trip people up on Pages:
- `functions/` must stay at the **repo root** (not inside `public/`). It is a special directory:
  those files are *not* served to visitors.
- A Pages Function named `functions/api/chat.js` creates the route `/api/chat`. If you name it
  `functions/chat.js`, the app will 404 while the site itself looks fine.
- Pages still works, but new features land on Workers first. If both projects exist, delete one —
  two deployments pointing at one repo is how people end up "fixing" the wrong one.
- Local equivalent of the Pages deploy: `npm run dev:pages` (uses the same `functions/` files).

## C · Your repo is also (currently, primarily) on Netlify

Netlify is the host this project ships on right now — see **[NETLIFY.md](NETLIFY.md)** for setup, the
env-var table and the two dashboard settings to fix. The repository being connected to two hosts is how
only one of them ends up with the secrets, which is what "the AI backend is not connected" usually means.
Two rules make the split safe:

- `netlify.toml` (committed) pins `publish = "public"` and `command = "npm run check"`, so a stale
  dashboard setting can no longer publish the wrong directory — that misconfiguration is exactly what made
  `/` 404 before.
- `/api/*` is redirected to `netlify/functions/api.mjs`, which imports the same `shared/api.js`. There is
  no second implementation to keep in sync, and `npm test` invokes the wrapper to prove it still routes.

If Netlify is not the host you want, **delete that site** (or disable PR/build triggers) rather than
leaving a stale copy of your "production" URL around. If it *is* the host you serve visitors from, add the
secrets in Netlify (Site settings → Environment variables → *Secrets*) and use
`reralm-ai.netlify.app` (or its custom domain) as the URL to test with `curl`.

One thing Netlify can silently do to you: **Site settings → Access & security → General** has "Deploy
previews / password" protection. If `...netlify.app` asks a visitor to sign in to Netlify, that switch is on
for non-production deploys (or for the whole site) — turn it off for a public product.

## D · Site on Netlify, API on a Cloudflare Worker (best of the two free tiers)

Use this when you want Netlify's git preview workflow for the pages but need more than 10 seconds per AI
answer. One deploy each, one shared codebase (`shared/api.js`), nothing to rewrite.

1. Deploy the API on Workers — it serves `/api/*` and you can ignore its static assets:
   ```bash
   npx wrangler login
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler deploy            # → https://realm-ai.<account>.workers.dev
   ```
   Workers has no duration ceiling like Netlify's free plan, so this is also the host to use for long
   answers. Add billing secrets here too if the API lives here:
   ```bash
   printf 'sandbox' | npx wrangler secret put PADDLE_ENV   # or paste at the prompt wrangler shows
   npx wrangler secret put PADDLE_CLIENT_TOKEN                # test_…
   npx wrangler secret put PADDLE_API_KEY                     # pdl_sdbx… → enables /api/checkout-status
   npx wrangler secret put PADDLE_WEBHOOK_SECRET              # trl_… from Paddle
   ```
2. Allow the Netlify origin to call it (otherwise the browser blocks the response):
   ```bash
   npx wrangler secret put ALLOWED_ORIGINS     # value: https://reralm-ai.netlify.app
   ```
   (comma-separate more origins, e.g. `https://realm.ai,https://www.realm.ai`). Requests with no `Origin`
   header — curl, Paddle's webhook — are unaffected.
3. On Netlify, set the API base: **Site configuration → Environment variables → `REALM_API_BASE`** is not
   enough (the page is static), so put the URL in `public/index.html` instead:
   ```html
   <meta name="realm:api" content="https://realm-ai.<account>.workers.dev" />
   ```
   Everything (`/api/chat`, `/api/agent`, `/api/health`, `/api/paddle-config`, `/api/checkout-status`)
   then goes to the Worker
   while the HTML/JS stays on Netlify. `npm test` asserts the base is normalised and that the default is
   still same-origin, so leaving the tag empty keeps the simple setup.
4. Point Paddle's webhook at `https://realm-ai.<account>.workers.dev/api/paddle/webhook` (the Worker, not
   Netlify — the function timeout doesn't matter there, but keep it to one place so events aren't
   journalled twice). Put `PADDLE_ENV`, `PADDLE_CLIENT_TOKEN`, `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET`
   on the **Worker** too, because `/api/paddle-config` and `/api/checkout-status` are served from there;
   `public/tiers.js` still ships from Netlify with the price ids.
   ```bash
   npx wrangler secret put PADDLE_WEBHOOK_SECRET
   npx wrangler secret put PADDLE_API_KEY
   printf 'sandbox' | npx wrangler secret put PADDLE_ENV
   ```
5. Verify:
   ```bash
   curl -sI -X OPTIONS https://realm-ai.<acct>.workers.dev/api/chat -H "Origin: https://reralm-ai.netlify.app" | grep -i access-control
   curl -s https://<netlify-site>/api/health          # → 404, expected: Netlify no longer serves the API
   ```

## Secrets

| Secret | Where it's read | If missing |
|---|---|---|
| `GEMINI_API_KEY` | `shared/api.js` → `/api/chat` | chat returns `503 AI_NOT_CONFIGURED`; the UI tells the visitor to paste a key in Settings |
| `GEMINI_MODEL` | same | defaults to `gemini-2.5-flash-lite` |
| `GEMINI_MODEL_FALLBACK` | same | no retry when the model name is wrong → `502 MODEL_NOT_FOUND` |
| `PADDLE_ENV`, `PADDLE_CLIENT_TOKEN` | `/api/paddle-config` | pricing page stays in preview mode (`503 PADDLE_NOT_CONFIGURED`) |
| `PADDLE_WEBHOOK_SECRET` | `/api/paddle/webhook` | every Paddle notification is refused (`503 WEBHOOK_NOT_CONFIGURED`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | webhook event journal + plan activation | events are verified + acked, `"activation":"log-only"` in `/api/health` |
| `PADDLE_API_KEY` | `/api/checkout-status`, webhook customer lookup | checkout confirmation replies `503 PADDLE_API_NOT_CONFIGURED`; welcome.html falls back to its static thank-you |
| `WEBHOOK_ACTIVATE=0` | webhook | events are verified and journalled without touching `subscriptions`/`payments`/`profiles` |
| `RATE_LIMIT_PER_MINUTE` | `/api/chat` | defaults to 20/min per visitor IP |
| `ALLOWED_ORIGINS` | all `/api/*` | cross-origin calls get no CORS headers (same-origin needs none) |

Never add a key as a plain **Variable** on a *public* site in a way that gets inlined into the build —
Variables are visible in some tooling; Secrets are not. This repo never reads keys from build-time
replacement: the frontend only ever calls `/api/*`.

## Custom domain

1. Buy/transfer the domain into this Cloudflare account (or use DNS Records for an external domain).
2. Workers → **Settings → Domains & Routes → Add → Custom domain** → `realm.ai` (Cloudflare provisions TLS).
3. Update `public/robots.txt`, `public/sitemap.xml` and the `YOUR-DOMAIN` placeholders in `index.html`
   to `https://realm.ai`, then redeploy and submit the sitemap in Google Search Console.
4. Paddle: add the domain under **Checkout → Website approval** (or the live/Pay links get blocked).
5. If you point a *different* origin at the same Worker (e.g. `www.` and apex), both work — no CORS needed,
   because everything is same-origin per request. `ALLOWED_ORIGINS` is only for third-party sites.

## Rollback / debugging in one command

```bash
curl -s https://YOUR-SITE/api/health | python3 -m json.tool
```

`ai.configured:false` → the secret isn't on the deployment you're hitting (wrong project, or no redeploy after adding it).
`ok` missing entirely / HTML response → the API isn't wired (output dir wrong on Pages, or `run_worker_first` missing on Workers).
