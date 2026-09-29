# Deploying Realm AI on Netlify (your current host)

Free tier is enough for this project: `*.netlify.app` subdomain, HTTPS + custom domain, static hosting,
and **Netlify Functions** for the API (125k invocations/month, 1024 MB memory, 26 s max duration).

`netlify.toml` in this repo is the whole configuration — Netlify reads it instead of the dashboard, so
nobody can accidentally set the wrong publish directory again:

```toml
[build]  command = "npm run check"   publish = "public"
[functions]  directory = "netlify/functions"  node_bundler = "esbuild"  timeout = 26
[[redirects]] from = "/api/*"  to = "/.netlify/functions/api/:splat"  status = 200  force = true
```

## One-time setup

1. **Add new site → Import an existing project → GitHub → `FahedBasra/realm-ai`.**
   Production branch: `main`. Netlify detects Node; `npm ci` runs from `package.json`.
2. **Site configuration → Environment variables → Add a variable** (once per variable). Only the first is
   required to get chat working:

   | Variable | Value | Needed for |
   |---|---|---|
   | `GEMINI_API_KEY` | key from aistudio.google.com/apikey | chat + agent |
   | `GEMINI_MODEL` | `gemini-2.5-flash-lite` (default) or another model you have access to | optional |
   | `RATE_LIMIT_PER_MINUTE` | `20` | per-visitor guard |
   | `PADDLE_ENV` / `PADDLE_CLIENT_TOKEN` | `sandbox` / `test_…` | billing (`PADDLE.md`) |
   | `PADDLE_WEBHOOK_SECRET` | `trl_…` | payment webhooks |
   | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | from Supabase | payment event log |

   Tick **Confidential** for keys so they are masked in the UI, and add them to *all* contexts
   (production + deploy previews) — a preview build without them will report "backend not connected",
   which is a correct answer but a confusing one to debug.
3. **Redeploy after adding variables** (Deploys → ⋯ → Redeploy). Netlify injects env vars at deploy time,
   so a running deploy keeps the old set.
4. That's it: `https://<your-site>.netlify.app/` serves the app and `/api/*` is live.

## Two settings to fix in your `reralm-ai` site

I could see these from the outside while testing this branch:

1. **Deploy previews are password-protected.** `https://deploy-preview-1--reralm-ai.netlify.app/`
   currently answers with Netlify's "This site is private — sign in" wall. For a product you are showing
   people, go to **Site configuration → Access & security control → Visitor access / Password protection**
   and set it to only protect branch deploys, or disable it. (Otherwise every shareable preview link looks
   broken to the visitor.)
2. **The site name has a typo** (`reralm-ai`). Site configuration → General → Change site name →
   `realm-ai`, which also renames the free subdomain to `realm-ai.netlify.app` and every preview URL.
   Old links stop working, so do it before you start sharing the URL.

## Verify

```bash
curl -s https://<your-site>.netlify.app/api/health | python3 -m json.tool
# "ai": {"configured": true, "model": "gemini-2.5-flash-lite"}  ← ready
# "configured": false                                            ← env var missing / no redeploy yet

curl -si -X POST https://<your-site>.netlify.app/api/chat \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"Say OK"}]}'
```

Or open the site → **Settings**: the backend strip reads `/api/health` and names whatever is missing.
Also worth enabling once: **Features → Functions → Inspect function logs** (or `netlify functions:serve`
locally with the CLI) — the wrapper writes nothing sensitive there.

## The 26-second ceiling, and why Agent mode doesn't hit it

A Netlify Function is killed at 26 s. A single long AI answer can exceed that, and you would get an
opaque `FUNCTION_TIMEOUT` instead of an answer. Two things handle it:

- `netlify/functions/api.mjs` passes `PROVIDER_TIMEOUT_MS=21000`, so Realm AI aborts the Gemini call
  itself and replies *"the model took too long — ask something narrower"* (a real message in the UI)
  instead of being killed.
- **Agent mode is split into one request per step** (`/api/agent` with `phase: plan | step | verify`).
  A 5-step job is 7 short requests with live progress in the UI, so total run time is unbounded while
  each request stays comfortably under the limit. The same design also gives you Stop/partial results
  for free, and works identically on Cloudflare (where there is no such ceiling).

If you want longer single answers (long code generations), either lower expectations per message, or move
the API to Cloudflare Workers (`CLOUDFLARE.md` section A) — Workers bill on CPU, not wall-clock, so a
60 s wait on the model costs nothing extra.

## Optional: local preview with the real runtime

```bash
npm install -g netlify-cli
netlify dev            # builds functions, serves public/, injects .env
```
Not required: `npm run dev` (Cloudflare runtime), `npm run dev:pages` and `npm run dev:mock` (runs the app
against `scripts/mock-gemini.mjs`, so you can click through chat and Agent mode with no key at all) exercise the same
`shared/api.js`, and `npm test` boots the actual UI + the Netlify function wrapper.

## Custom domain later

Domain settings → Add domain → buy or connect. Then update `public/robots.txt`, `public/sitemap.xml`
and the `YOUR-DOMAIN` placeholders in `public/index.html` (canonical/og:url are also corrected at runtime,
so social previews are fine meanwhile), and add the domain in Paddle → Checkout → Website approval.
