# Realm AI + Paddle (billing)

Realm AI uses **Paddle as merchant of record**: Paddle computes tax/VAT per country, charges the
customer, and hands you a webhook. You never touch card data. JazzCash/EasyPaisa-style local rails can be
added later as a second provider (`/api/payment/jazzcash/create` is intentionally a `501` stub in this repo —
it refuses to take money until an approved merchant account exists).

## 1. Plans you edit in one place

`public/tiers.js` is the only file that describes plans. Features, highlight flag, and the two Paddle price IDs:

```js
{ name: 'Pro', highlight: true,
  features: ['Everything in Starter', 'AI Agent mode'],
  priceId:  { month: 'pri_01abc...', year: 'pri_01def...' },   // from Paddle catalog
  fallback: { month: '$15', year: '$150' } }                     // display-only, before Paddle is live
```

`npm run check` warns while the IDs still say `pri_REPLACE_ME`. While they do, the pricing page renders
**preview plans with disabled buttons** instead of an error — deliberate, so a half-configured launch never
shows a red box to customers.

## 2. Sandbox first

1. Create a Paddle sandbox account (sandbox-login.paddle.com).
2. **Catalog → Products → New**: one product per tier, each with a monthly *and* yearly recurring price.
   Copy each `pri_…` id into `public/tiers.js`.
3. **Developer tools → Authentication → New client-side token** → copy the `test_…` token.
4. Cloudflare secret (Workers) or Pages secret:

```bash
npx wrangler secret put PADDLE_ENV          # value: sandbox
npx wrangler secret put PADDLE_CLIENT_TOKEN # value: test_…   (must match PADDLE_ENV)
```

The backend refuses to serve a mismatched pair (`500 PADDLE_TOKEN_MISMATCH`) rather than letting you debug
a silent Paddle-side failure. `curl https://YOUR-SITE/api/paddle-config` should answer
`{"environment":"sandbox","clientToken":"test_…","country":"PK"}`.

5. Deploy → Pricing tab → prices should now come from Paddle (localized, tax-aware) and Subscribe opens Checkout.
   The visitor's country comes from Cloudflare's `cf-ipcountry`, so the page price equals the checkout price.

## 3. Webhooks (server-side truth)

**Developer tools → Notifications → Add endpoint**:
`https://YOUR-SITE/api/paddle/webhook`, event types: `transaction.paid`, `transaction.completed`,
`subscription.created`, `subscription.updated`, `subscription.canceled`, `payment_failed`.
Copy the **signing secret** (`trl_…`) into Cloudflare:

```bash
npx wrangler secret put PADDLE_WEBHOOK_SECRET
```

Rules enforced by `shared/api.js`:
- Signature is HMAC-SHA256 over `"<ts>:<raw body>"`; a mismatch or a timestamp older than 5 minutes → `401`.
- SHA-1 subkeys are rejected on purpose (Paddle lets you pick the algorithm — pick **SHA-256**).
- If `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set, verified events are inserted into `payment_events`
  (idempotent on `event_id`). Otherwise the endpoint just acks, so Paddle doesn't retry forever.
- **Nothing marks a plan "active" yet.** Activation requires user accounts (Supabase Auth), which is
  Sprint C in `NEXT_STEPS.md`. Until accounts exist there is no user to attach a plan to, and silently
  pretending otherwise is how paid products ship security holes.

Test it locally with a real signature (no Paddle account needed):

```bash
npm run dev &
node -e '
const body=JSON.stringify({event_id:"evt_local_1",event_type:"transaction.paid",occurred_at:new Date().toISOString(),data:{id:"txn_1"}});
const ts=Math.floor(Date.now()/1000);
const {createHmac}=require("crypto");
const v1=createHmac("sha256","trl_local").update(`${ts}:${body}`).digest("hex");
fetch("http://127.0.0.1:8787/api/paddle/webhook",{method:"POST",body,headers:{"content-type":"application/json","paddle-signature":`ts=${ts};v1=${v1}`}}).then(async r=>console.log(r.status,await r.text()));'
# with PADDLE_WEBHOOK_SECRET=trl_local in .dev.vars → 200 {"received":true,...}
```

## 4. Going live

1. Paddle live account → approve the domain in **Checkout → Website approval** (otherwise Checkout shows
   "not allowed to load" / refuses to open for visitors).
2. Recreate the products/prices in the **live** catalog, paste the new `pri_…` ids into `public/tiers.js`.
3. Rotate the secrets: `PADDLE_ENV=production`, `PADDLE_CLIENT_TOKEN=live_…`, live webhook secret.
4. `npm run check && npm test` then deploy. Settings → Backend strip on the live site should read
   `Paddle production` (no token mismatch suffix).
5. Add a real sales inbox: in `public/index.html` find `const SALES={email:''}` and set the address that
   should receive Enterprise enquiries (until then, "Contact sales" says it's unavailable instead of silently
   dropping the message).

## Price display details worth knowing

- `Paddle.PricePreview()` (v2) returns `data.details.lineItems[]`, each `{ price, cost: { formatted, amount, currencyCode } }`.
  `pricing.js` reads `cost.formatted`; the previous code read a field Paddle never sends
  (`formattedTotals.total`), which threw inside the render function and left the pricing section frozen on
  "Loading prices…". Both spellings are accepted now.
- Price IDs are `pri_` + 26 lowercase alphanumerics. A typo'd id is treated as "not configured" (preview mode)
  instead of firing a failing preview request per page load.
- `Paddle.Checkout.open(... settings.successUrl ...)` → `/welcome.html`.
