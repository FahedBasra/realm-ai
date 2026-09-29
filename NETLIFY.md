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

## The 10-second ceiling on the free plan (read this once)

Netlify caps a **Function** at 10 seconds on the free (Starter) plan; ~26-30s needs a paid plan, and
setting `[functions] timeout = 26` in `netlify.toml` on a free site does not quietly get clamped —
**the whole deploy fails at config validation** (that exact mistake cost one red build on this repo, so
the key is deliberately absent and `npm run check` now refuses to let it come back).

Realm AI is built so the ceiling rarely matters:

- **Agent mode is one request per phase** (`plan` → each `step` → `verify`). A 5-step job is 7 short
  requests with live progress in the UI, so the total run is unbounded while no single request gets near
  10s. It also buys you Stop, per-step retry, and partial results kept on screen.
- `netlify/functions/api.mjs` defaults `PROVIDER_TIMEOUT_MS=8000` and `GEMINI_MAX_TOKENS=700`, so a slow
  answer ends as *"the model took too long — ask something narrower"* in the chat bubble rather than an
  opaque `FUNCTION_TIMEOUT` in the browser console. A long code dump can genuinely need more than 700
  tokens, so on Netlify keep messages focused and let the agent's step-by-step output be the long artifact.
- Set `RATE_LIMIT_PER_MINUTE` too: a free-plan site is easy to hammer, and every chat message costs a
  provider call.

If you need long single answers (e.g. "write me a 400-line file") on a free plan, keep the **site** on
Netlify and move the **API** to a Cloudflare Worker — Workers bill on CPU time, not wall-clock, so a
45-second generation costs nothing extra and is free up to 100k requests/day. It's a 10-minute change and
the app already supports it: set `REALM_API_BASE` / the `<meta name="realm:api">` tag to the Worker URL and
add the Netlify origin to the Worker's `ALLOWED_ORIGINS`. Exact steps: `CLOUDFLARE.md` §D.

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
