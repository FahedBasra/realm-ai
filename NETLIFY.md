# Deploying Realm AI on Netlify (your current host)

Free tier is enough for this project: `*.netlify.app` subdomain, HTTPS + custom domain, static hosting,
and **Netlify Functions** for the API (125k invocations/month, 1024 MB memory, **10 s** max duration on the
free plan — see the ceiling section below; ~26-30 s only on paid plans).

`netlify.toml` in this repo is the whole configuration — Netlify reads it instead of the dashboard, so
nobody can accidentally set the wrong publish directory again:

```toml
[build]  command = "npm run check"   publish = "public"
[functions]  directory = "netlify/functions"  node_bundler = "esbuild"   # no `timeout` key: see below
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
   | `PADDLE_ENV` / `PADDLE_CLIENT_TOKEN` | `sandbox` / `test_…` | opening Paddle Checkout (`PADDLE.md`) |
   | `PADDLE_API_KEY` | `pdl_sdbx…` (sandbox) | checkout confirmation + activating plans from webhooks |
   | `PADDLE_WEBHOOK_SECRET` | `trl_…` | verifying payment webhooks |
   | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | from Supabase | payment event log + plan activation |

   Tick **Confidential** for keys so they are masked in the UI, and add them to *all* contexts
   (production + deploy previews) — a preview build without them will report "backend not connected",
   which is a correct answer but a confusing one to debug.
   Terminal version of the same thing (needs `npm i -g netlify-cli` once, then `netlify login` + `netlify link`):

   ```bash
   npx netlify env:set GEMINI_API_KEY '<paste>'      # no quotes inside, no trailing space
   npx netlify env:set GEMINI_MODEL gemini-2.5-flash-lite
   npx netlify env:set RATE_LIMIT_PER_MINUTE 20
   ```

   Prefer not to type them at all? `GEMINI_API_KEY=… npm run setup:gemini` validates the key against Google,
   writes `.dev.vars` and prints the `env:set` lines for this site; `npm run setup` then lists what is missing.

3. **Redeploy after adding variables** (Deploys → ⋯ → Redeploy). Netlify injects env vars at deploy time,
   so a running deploy keeps the old set.
4. That's it: `https://<your-site>.netlify.app/` serves the app and `/api/*` is live.

## Two settings to fix in your `reralm-ai` site

These two are the difference between "deployed" and "reachable by a customer" — nobody outside your Netlify
account can open the site until #1 is off (verified from outside on 2026-09-29: `https://reralm-ai.netlify.app/api/health`
answers with Netlify's sign-in wall instead of the app):

1. **Project visibility is `Private`, so the whole site is behind Netlify login.** Every URL — production and
   previews — answers with "This site is private — sign in" instead of the app. Verified from outside:
   `https://reralm-ai.netlify.app/` returns Netlify's edge-access wall even after a green deploy, so *this* is
   the last thing between "deployed" and "live". Fix (on credit-based plans, which includes free accounts
   created after Sep 2025):

   **Netlify → your project → Project configuration → General → Visitor access → Project visibility → `Public`**
   (older/Enterprise UI: Project configuration → Access & security → Visitor access → Password protection → off).

   Two gotchas, both common:
   - The scope below the selector matters: **"Production and previews"** protects everything,
     **"Previews only"** keeps the live site public — pick that if you want shareable previews to stay gated.
   - If the per-project selector is greyed out, a **team default** is overriding it: Team settings → General →
     Visitor access → Default project visibility → choose *Public for new projects* (the "Private for all
     projects" setting locks every existing project too, and individual projects cannot be made public).

   Confirm with something that is *not* logged into Netlify — a phone on mobile data, or a private window:
   `https://reralm-ai.netlify.app/api/health` should print JSON. `curl` from a sandbox or CI box will also
   show the wall, which is why this bug survives "my checks pass".
   *Note:* `Private` is Netlify's default for new projects now — nothing you did wrong, but it does have to be
   flipped manually before you send anyone the link.*
2. **The site name has a typo** (`reralm-ai`). Site configuration → General → Change site name →
   `realm-ai`, which also renames the free subdomain to `realm-ai.netlify.app` and every preview URL.
   Old links stop working, so do it **before** you start sharing the URL, then sync the SEO files to the
   new host (this repo currently points canonical + sitemap at `reralm-ai.netlify.app`):
   ```bash
   sed -i 's#reralm-ai\.netlify\.app#realm-ai.netlify.app#g' public/robots.txt public/sitemap.xml public/index.html
   npm run check && git commit -am "SEO: live host" && git push
   ```

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
