# Realm AI — next steps

Status after the current cleanup: the site deploys cleanly on **Netlify** (and on Cloudflare, identically),
`/api/chat` and `/api/agent` work with one secret, billing is wired end to end but stays in preview mode until
Paddle credentials and price ids arrive, webhooks now *activate* plans when Supabase is configured, and
`npm run setup` reports exactly which of those steps is still open. What's left is product work, in
dependency order.

## Done (so you don't redo it)

- Structure Cloudflare can actually serve: `public/index.html`, API routes in `functions/api/*`,
  shared logic in `shared/api.js`, `wrangler.json` for the Workers deployment. Both deployment styles
  run the same code and are tested locally (`npm run dev`, `npm run dev:pages`).
- Server-side AI: Gemini call in the Worker, key from secrets only, request/response caps, provider error
  mapping, optional per-IP rate limiting, model fallback, safety-block and truncation handled as messages.
- Agent runner: `/api/agent` phases (plan/step/verify) with progress UI, Stop, retry, JSON-mode plans
- Frontend resilience: the UI no longer dies when `/api/*` is missing (it says what's missing), no longer
  cross-wires the Settings fields (display name used to overwrite the Gemini model input, which then made
  every direct-key test fail with a bogus model name), and Pricing renders preview plans when Paddle is unset.
- Security headers (`public/_headers`), `robots.txt`, `sitemap.xml`, `404.html`, Supabase schema with RLS.
- **Checkout confirmation**: `GET /api/checkout-status?txn=…` asks Paddle (never the browser) what happened to
  a transaction, and `/welcome.html` polls it until the payment is `paid`/`canceled` — so the thank-you page
  cannot be forged by editing the URL and never lies while a 3-D Secure step is still in flight.
- **Webhook → plan activation**: `subscription.*` upserts `subscriptions` on `(provider, provider_ref)`,
  `transaction.*` inserts `payments` idempotently, and `profiles.plan` follows the tier from `customData.tier`
  (email resolved through the Paddle API). Cancel/past_due drop it back to `free`; DB failures are reported
  without making Paddle retry a valid event; `WEBHOOK_ACTIVATE=0` switches it off.
- `scripts/setup.mjs` (`npm run setup`, `setup:gemini`, `setup:paddle`): validates the Gemini key against
  Google and picks a model it can actually use; creates the Paddle products + monthly/yearly prices and writes
  the `pri_…` ids back into `public/tiers.js`; checks that sandbox/live credentials aren't mixed.
- CI: `.github/workflows/ci.yml` runs `npm run check` (structure, leftover placeholders, secret scan,
  import resolution) + `npm test` + `wrangler deploy --dry-run`.

## Sprint A · publish

1. Follow `CLOUDFLARE.md` section A or B, add `GEMINI_API_KEY`.
2. Confirm `curl https://YOUR-SITE/api/health` → `"ai":{"configured":true}`.
3. Custom domain, then replace `YOUR-DOMAIN` in `public/robots.txt`, `public/sitemap.xml`,
   `public/index.html` (canonical + og:url) and submit the sitemap in Search Console.

## Sprint B · accounts (this unblocks paid plans)

Create a Supabase project, run `supabase/schema.sql` in its SQL editor, then in the frontend:
- replace the login modal stub (`window.loginSoon`) with Supabase Auth (email magic link is the least code),
- set `window.REALM_USER = { email, id }` after login — `pricing.js` already attaches that email to checkout,
  and the webhook already writes `profiles.plan` by email, so **activation needs no new code**: the app only has
  to *read* the plan (and pass the JWT to `/api/chat`) once accounts exist,
- move chat history from `localStorage` into `conversations` / `messages` (RLS already scopes rows to `auth.uid()`).

Secrets stay server-side: only the **anon** key may appear in the page. The service-role key belongs in
Cloudflare (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and is already used that way by the webhook journal.

## Sprint C · per-user AI budget

`/api/chat` is currently public (rate-limited per IP). Once accounts exist:
- accept the Supabase JWT (`Authorization: Bearer …`) in `shared/api.js`,
- read/write `usage.messages_count` per month, compare against the plan in `subscriptions`,
- return `402`/`429` with a clear code and let the UI show "upgrade" instead of an error.
Start here: `normalizeMessages()` + `enforceRateLimit()` in `shared/api.js` are the two seams.

## Sprint D · real file handling

Browser-side `FileReader` (index.html, `renderFiles`) only previews text files up to ~30k chars. For production:
upload to authenticated Supabase Storage from the client, then parse server-side (add a `/api/files/parse`
route in `shared/api.js`), with type + size limits and a virus scan where available. Never send whole
binaries to the model. PDF/DOCX extraction is a Worker dependency (`pdf-parse`, `mammoth`) — Workers support
npm packages, keep it out of the browser.

## Sprint E · agents — server-side runner DONE, tools next

`/api/agent` now runs plan → each step → verify **on the server**, one model call per phase
(`shared/api.js`, `agentPrompt()`), with capped steps (6), per-step output truncation, JSON-mode planning,
tolerant JSON parsing, live progress/Stop/retry in the UI, and the same auth + rate limits as chat.
This replaced the old single-prompt `runAgent`, which had no plan, no verification and no progress.

Still open, in order of value:
1. **Tool allowlist**: give the plan a `tool` field per step (`search`, `calc`, `extract_from_file`) and
   execute approved tools inside the step phase, then `verify` the tool output. Keep execution in
   `shared/api.js` — never in the page.
2. **Persistence**: `agent_runs` / `agent_steps` tables in `supabase/schema.sql`, so a run survives a reload
   and can be resumed at the failed step (the client currently holds the transcript between phases, which is
   enough without accounts but loses work on refresh).
3. **Real budget**: count `usage.agent_runs` per user once Sprint B lands.

## Sprint F · local payments (Pakistan)

JazzCash/EasyPaisa need an approved merchant account. The stub route
(`/api/payment/jazzcash/create` → `501 JAZZCASH_NOT_CONFIGURED`) exists so nothing takes money by accident.
When credentials arrive: initiate server-side, verify the IPN/callback signature server-side, write the
`payments` row, activate `subscriptions`, and only then redirect to `welcome.html`. Paddle remains the
easier global option; don't run both for the same plan.

## Sprint G · launch checklist

- [ ] `/api/health` green on the production URL, `ai.configured:true`, `billing.paddleConfigured:true`
- [ ] `npm run check` has zero warnings (domain + price IDs set)
- [ ] Agent mode: run a 3-step goal end to end on the deployed URL and confirm Stop + retry-a-step work
- [ ] Paddle **live** catalog, website approval, live webhook secret, `PADDLE_ENV=production`
      (`PADDLE_API_KEY` too, or the welcome page can't confirm payments from the server)
- [ ] One real sandbox checkout on the deployed URL: test card `4242 4242 4242 4242`, then confirm
      `/welcome.html?_ptxn=…` shows "Payment confirmed" and the webhook in Paddle's dashboard shows `200`
- [ ] `npm run setup` clean (no blocking findings) on the machine you deploy from
- [ ] `RATE_LIMIT_KV` bound; abuse reviewed via `npx wrangler tail`
- [ ] Mobile: upload limits, keyboard on chat input, voice fallback toast
- [ ] Legal: replace the placeholder Privacy/Terms text in `index.html` (`const LEGAL = {...}`) with real text
- [ ] Error tracking (Cloudflare Workers logpush → a drain, or Sentry) wired to the Worker
