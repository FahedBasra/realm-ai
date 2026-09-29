# Realm AI — next steps

Status after the current cleanup: the site deploys cleanly on Cloudflare, `/api/chat` works with one
secret, billing and payment webhooks are wired but disabled until you add Paddle credentials, and the
database schema is ready to paste into Supabase. What's left is product work, in dependency order.

## Done (so you don't redo it)

- Structure Cloudflare can actually serve: `public/index.html`, API routes in `functions/api/*`,
  shared logic in `shared/api.js`, `wrangler.json` for the Workers deployment. Both deployment styles
  run the same code and are tested locally (`npm run dev`, `npm run dev:pages`).
- Server-side AI: Gemini call in the Worker, key from secrets only, request/response caps, provider error
  mapping, optional per-IP rate limiting, model fallback, safety-block and truncation handled as messages.
- Frontend resilience: the UI no longer dies when `/api/*` is missing (it says what's missing), no longer
  cross-wires the Settings fields (display name used to overwrite the Gemini model input, which then made
  every direct-key test fail with a bogus model name), and Pricing renders preview plans when Paddle is unset.
- Security headers (`public/_headers`), `robots.txt`, `sitemap.xml`, `404.html`, Supabase schema with RLS.
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

## Sprint E · agents

`runAgent` currently sends one long instruction and prints the result. A real runner needs a server-side
loop: plan → step → tool call → verify → final answer, with a persisted step log (add `agent_runs`,
`agent_steps` tables) and an allowlist of tools. Keep tool execution in the Worker, never in the page.

## Sprint F · local payments (Pakistan)

JazzCash/EasyPaisa need an approved merchant account. The stub route
(`/api/payment/jazzcash/create` → `501 JAZZCASH_NOT_CONFIGURED`) exists so nothing takes money by accident.
When credentials arrive: initiate server-side, verify the IPN/callback signature server-side, write the
`payments` row, activate `subscriptions`, and only then redirect to `welcome.html`. Paddle remains the
easier global option; don't run both for the same plan.

## Sprint G · launch checklist

- [ ] `/api/health` green on the production URL, `ai.configured:true`, `billing.paddleConfigured:true`
- [ ] `npm run check` has zero warnings (domain + price IDs set)
- [ ] Paddle **live** catalog, website approval, live webhook secret, `PADDLE_ENV=production`
- [ ] `RATE_LIMIT_KV` bound; abuse reviewed via `npx wrangler tail`
- [ ] Mobile: upload limits, keyboard on chat input, voice fallback toast
- [ ] Legal: replace the placeholder Privacy/Terms text in `index.html` (`const LEGAL = {...}`) with real text
- [ ] Error tracking (Cloudflare Workers logpush → a drain, or Sentry) wired to the Worker
