# Realm AI + Paddle (billing)

Realm AI uses **Paddle as merchant of record**: Paddle computes tax/VAT per country, charges the customer,
and hands you a webhook. You never touch card data and you never store a card form. JazzCash/EasyPaisa-style
local rails can be added later as a second provider (`/api/payment/jazzcash/create` is intentionally a `501`
stub — it refuses to take money until an approved merchant account exists).

Everything below is also checked by a tool: `npm run setup` tells you which of these steps are still missing.

---

## 0. Making the accounts (the part people get stuck on)

There are **two Paddle accounts**, and they are separate products with separate logins, separate data and
separate keys. Nothing carries over between them except the email address you used.

| | Sandbox (testing) | Production (real money) |
|---|---|---|
| Sign up | <https://sandbox-vendors.paddle.com/signup> | <https://vendors.paddle.com/signup> |
| Dashboard | `sandbox-vendors.paddle.com` | `vendors.paddle.com` |
| API base | `https://sandbox-api.paddle.com` | `https://api.paddle.com` |
| API key looks like | `pdl_sdbx…` (contains `_sdbx`) | `pdl_…` (no `_sdbx`) |
| Client-side token | `test_…` | `live_…` |
| Website approval | not needed | required before real checkouts work |
| Payouts | none — no money moves | to your bank, ~weekly after the first |

> **The #1 reason signups "don't work":** `sandbox-login.paddle.com` is the *legacy Paddle 1.0* login. A
> sandbox account made there is a different system; new Paddle Billing sandboxes are created at
> **`sandbox-vendors.paddle.com/signup`**. If that form gives you an error, try the "Create sandbox" button
> inside the production dashboard (top-right menu) — it creates the sandbox for the same email.

### Sandbox — what you actually have to fill in

1. <https://sandbox-vendors.paddle.com/signup> → use an email you can read *right now* (a verification link is sent).
2. **Personal details**: full name, and a password (12+ chars). No phone, no card, no ID.
3. **Business details**: pick *Individual / sole trader* if you don't have a registered company; enter your
   address including country. Tax ID fields can be left empty for sandbox.
4. Verify the email → log in. The dashboard has a yellow **Test Mode** watermark — that is correct.

Sandbox gives you the full Catalog + API + Checkout immediately; nothing is reviewed and nothing expires.

### Production — why it isn't instant

Paddle is the *seller of record*, so it vets who it takes money for. Live signup asks for country, business
type, website, what you sell, and (depending on country) ID + bank details. Review is manual — usually a few
hours to a few days, by email. Two things people blame incorrectly:

- **Country.** Pakistan is not on Paddle's unsupported list, and Paddle supports selling *to* PK. If a form
  rejects the country or checkout says `E-403 / country not supported`, **turn off the VPN.** A VPN makes the
  browser geo and the dashboard geo disagree, which is exactly what their fraud checks look at.
- **"We can't verify you".** A gmail address + no real product page + no terms/privacy page is what most
  rejections are actually about. Publish the site first (you already have Netlify running), add
  `/terms` and `/privacy` links, then apply.

Sandbox is deliberately unblocked: keep building and testing while the live review runs.

### The Gemini key (same page, 30 seconds)

1. <https://aistudio.google.com/apikey> → sign in with Google → **Create API key** → copy `AIza…`.
   Free tier is enough to launch; Pakistan is in the supported-countries list for the Gemini API, so no VPN.
2. Hand it to the machine — never paste it into the repo, an issue, or a chat window:
   ```bash
   GEMINI_API_KEY='AIza…' npm run setup:gemini
   ```
   The script asks Google whether the key works, picks a model that key actually has, writes `.dev.vars`, and
   prints the command that puts it on your host. If it says the key was rejected, it is a copy/paste problem
   (spaces, quotes, or the wrong project) — not a code problem.

---

## 1. Plans live in one file

`public/tiers.js` is the only place that describes plans:

```js
{ name: 'Pro', description: 'For power users and builders.', highlight: true,
  features: ['Everything in Starter', 'AI Agent mode'],
  priceId:  { month: 'pri_01abc...', year: 'pri_01def...' },   // from the Paddle catalog
  fallback: { month: '$15', year: '$150' } }                     // display-only, until Paddle is connected
```

While the ids still say `pri_REPLACE_ME`, the pricing page renders **preview plans with disabled buttons**
instead of an error box — deliberate, so a half-configured launch never shows a red card to customers.
`npm run check` and `npm run setup` both warn about it.

## 2. Create the catalog with one command (instead of clicking 9 forms)

```bash
npm run setup:paddle                     # uses PADDLE_API_KEY from the environment
PADDLE_API_KEY='pdl_sdbx…' node scripts/setup.mjs paddle
# flags:  --prices 5,15,25   --base <url>   --dry-run   --no-write
```

What it does: reads the tiers from `public/tiers.js`, then `POST /products` (one per tier,
`tax_category: saas`) and `POST /prices` (monthly + yearly), and writes the returned `pri_…` ids straight
back into `public/tiers.js`, preserving your comments and formatting. Prices are **USD** — Paddle has no PKR
price currency; it converts and collects in the buyer's currency and pays you in the one you chose.

Prefer the dashboard? **Catalog → Create product** → name + `Software / SaaS` tax category → add two
*Recurring prices* (Monthly, Yearly) → copy each price id into `tiers.js`.

If the script reports HTTP 403/401, it is environment confusion, not code: a `_sdbx` key must call
`sandbox-api.paddle.com`, a live key `api.paddle.com`, and the key needs the *products:write / prices:write*
permission (create a fresh key with "Full developer access" while developing).

## 3. Secrets — set them on the host that serves `/api`

```bash
# Netlify (dashboard works too: Site configuration → Environment variables → check "Secret")
npx netlify env:set PADDLE_ENV sandbox
npx netlify env:set PADDLE_CLIENT_TOKEN 'test_…'
npx netlify env:set PADDLE_API_KEY 'pdl_sdbx…'
npx netlify env:set PADDLE_WEBHOOK_SECRET 'trl_…'      # from step 4
# …then redeploy so the functions pick them up
```

```bash
# Cloudflare Workers
npx wrangler secret put PADDLE_ENV && echo sandbox   # paste at the prompt instead
npx wrangler secret put PADDLE_CLIENT_TOKEN
npx wrangler secret put PADDLE_API_KEY
npx wrangler secret put PADDLE_WEBHOOK_SECRET
```

Only `PADDLE_ENV` + `PADDLE_CLIENT_TOKEN` are needed for a checkout to open; the API key and webhook secret are
for the server side (confirmation + activation). `GET /api/paddle-config` is the check:

```bash
curl -s https://YOUR-SITE/api/paddle-config | python3 -m json.tool
# {"environment":"sandbox","clientToken":"test_…","country":"PK"}
```

It returns `503 PADDLE_NOT_CONFIGURED` when unset and refuses a mismatched pair
(`PADDLE_TOKEN_MISMATCH`) rather than letting you debug a silent failure inside Paddle's iframe.

## 4. Webhooks: the server-side truth (and what it now does)

**Developer tools → Webhooks → Add endpoint**, URL `https://YOUR-SITE/api/paddle/webhook`, events
`subscription.*`, `transaction.*`, `payment_method.*` (or "all"), and copy the **signing secret** (`trl_…`)
into `PADDLE_WEBHOOK_SECRET`. In sandbox the "Test" button lets you resend any event — use it and watch the
response body; `/api/paddle/webhook` replies with what it did:

```json
{ "received": true, "event_type": "transaction.paid", "event_log": "stored",
  "activation": "activate", "actions": ["payment:ok", "plan:ok"] }
```

Rules `shared/api.js` enforces:

- Signature is HMAC-SHA256 over `"<ts>:<raw body>"`; a mismatch or a timestamp older than 5 minutes → `401`.
  SHA-1 subkeys are rejected on purpose — pick **SHA-256** in the dashboard.
- Verified events are written to `payment_events` (idempotent on `event_id`) when Supabase is configured.
- **Plan activation now exists**: with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set, `supabase/schema.sql`
  tables are updated — `subscriptions` upserted on `(provider, provider_ref)`, `payments` inserted idempotently,
  and `profiles.plan` set to the tier from `customData.tier` (matched by customer email, which Paddle's
  `customer_id` resolves through the API). Cancellations and `past_due` drop the plan back to `free`.
  A database error is reported but still returns `200`, so Paddle never retries a valid payment forever.
  `WEBHOOK_ACTIVATE=0` keeps verification and logging while touching no table.
- Until user accounts exist, activation has nothing to attach a plan to: it writes the rows and logs
  `plan:failed 404`/no rows. That is the honest state, not a bug.

`GET /api/checkout-status` is directly testable too:

```bash
curl -s "http://127.0.0.1:8787/api/checkout-status?txn=$(printf 'txn_%s' "$(python3 -c "print('a'*26)")")" | python3 -m json.tool
```

Local dry run — no Paddle account, no tunnel, a real HMAC. `npm run dev:mock` starts the server with
`PADDLE_WEBHOOK_SECRET=trl_local` and a mock Supabase, then:

```bash
npm run mock:webhook                              # transaction.paid → activation: payment:ok, plan:ok
node scripts/mock-webhook.mjs --event subscription.canceled
node scripts/mock-webhook.mjs --event payment_failed
```

## 5. Test a checkout end to end

Pricing tab → **Subscribe** → Paddle Checkout opens. In sandbox:

| Card | What happens |
|---|---|
| `4242 4242 4242 4242` | succeeds, no 3-D Secure |
| `4000 0038 0000 0446` | succeeds through a 3-D Secure step |
| `4000 0000 0000 0002` | declined — use this to test the failure path |
| `4000 0566 5566 5556` | Visa debit, succeeds |

Any future expiry, any CVC, any billing address in your account's country. After it completes, Paddle sends
the browser to `/welcome.html?_ptxn=txn_…`; that page calls `GET /api/checkout-status?txn=…`, asks Paddle
itself, and shows plan + amount + status. Nothing on that page is trusted from the URL except the id, and the
id is only ever looked up — so the confirmation can't be faked by editing the address bar.

If the redirect lost the id (an emailed link, a privacy extension stripping the query), the page shows a
lookup box: paste `txn_…` from the receipt and it calls the same endpoint. Nothing in the page is trusted
beyond that id, and it is only ever *looked up*.

Two sandbox quirks that look like bugs but are not:

- **Receipt emails** only arrive at an address matching the email domain you registered (`you@company.com`).
  Paddle blocks sandbox mail to gmail.com etc. to stop free testing accounts being used as a mailing list —
  register sandbox with a domain you own, or accept that the receipt won't arrive (the checkout still works).
- **Refunds** are auto-approved in sandbox every ~10 minutes, so subscription states move on their own.

Webhook delivery in sandbox retries 3 times over ~15 minutes, then gives up and marks the endpoint failed —
fix the endpoint and resend from the dashboard rather than recreating it.

## 6. Going live

1. **Checkout → Website approval**: approve your domain, otherwise Checkout refuses to load for visitors.
2. Re-create the catalog in the **live** account and re-run the script with the live key — it writes the new
   `pri_…` ids into `tiers.js` (sandbox ids and live ids are never interchangeable).
3. Rotate secrets: `PADDLE_ENV=production`, `PADDLE_CLIENT_TOKEN=live_…`, live `PADDLE_API_KEY`, live
   `PADDLE_WEBHOOK_SECRET`, then redeploy.
4. `npm run setup && npm test` → both should be clean before you point a customer at it. Check
   `/api/health`: `"billing": { "paddleConfigured": true, "environment": "production", "tokenMatchesEnv": true, … }`.
5. Settings → **Sales inbox** (`const SALES = { email: '…' }` in `public/index.html`) so Enterprise enquiries
   reach a human instead of being silently dropped.

## Price display details worth knowing

- `Paddle.PricePreview()` returns `data.details.lineItems[]`, each `{ price, cost: { formatted, amount, currencyCode } }`.
  `pricing.js` reads `cost.formatted`; the earlier version of this repo read a field Paddle never sends
  (`formattedTotals.total`), which threw inside the render function and left the section frozen on
  "Loading prices…". Both spellings are accepted now.
- Price ids are `pri_` + 26 lowercase alphanumerics. A typo'd id counts as "not configured" (preview mode)
  instead of firing a failing request on every page load.
- `unit_price.amount` is a **string of minor units** (`"1500"` = $15.00) and `currency_code` must be one of
  Paddle's supported currencies. `tax_category` is mandatory when creating a product.
- `Paddle.Checkout.open({ successUrl })` → `/welcome.html`; Paddle appends `_ptxn` itself.
