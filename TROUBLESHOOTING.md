# Realm AI troubleshooting

Ordered by how often they happen. Start with the two commands that tell you most:

```bash
npm run check                        # repo structure (does the deploy have a chance of working?)
curl -s https://YOUR-SITE/api/health # what the LIVE deployment actually sees
```

If `/api/health` answers, the API plumbing is fine and the problem is a secret/value. If it answers with
**HTML** (or 404), the API is not wired at all — ignore everything else and fix the deployment first.

## Site

| Symptom | Cause | Fix |
|---|---|---|
| Root URL is a 404, but `/index.html` works | Cloudflare only maps `/` to a file literally named `index.html` in the output dir. `index (2).html`, `Index.HTML`, `index.html.txt` (Windows/Downloads habit) all break it | Keep the file at `public/index.html`; `npm run check` refuses to pass otherwise |
| Whole page blank, no console errors | Pages **Build output directory** is `/` or `.` while files live in `public/` | Settings → Build & deployments → Build output root → `public` → Retry deployment |
| CSS/JS 404 (`/tiers.js`, `/pricing.js`) | Files outside the output dir, or deployed the Worker without assets | They must be inside `public/`; `wrangler.json` needs `assets.directory = "./public"` |
| Deployment succeeds, then the old site is still served | Edge cache | Purge Cloudflare cache (Caching → Purge everything) and hard-reload; asset HTML is served with `must-revalidate` so this is rare |
| Only on mobile Safari: layout fine, chat dead | Old JS syntax in a custom edit | `npm run check` parses every inline script; keep optional chaining to `?.` forms already used here |

## Chat / AI

| Symptom | Cause | Fix |
|---|---|---|
| "The AI backend is not connected yet" | No `GEMINI_API_KEY` secret on *that* deployment, or you added it and never redeployed | Pages: add it under **Production** (not Preview) then retry the deployment. Workers: `npx wrangler secret put GEMINI_API_KEY` |
| Error text: `Unknown name "contents"` / `400` from Google | Bad request body from a hand-edited route | Use `shared/api.js` as-is; `npm test` covers the request shape |
| `502 MODEL_NOT_FOUND`, message names the model | `GEMINI_MODEL` typo / retired model / key without access | Set `GEMINI_MODEL=gemini-2.5-flash-lite`; optionally `GEMINI_MODEL_FALLBACK=gemini-2.5-flash` (the route retries it once) |
| `502 BAD_KEY` "API key not valid" | Key pasted with a space/newline, or a Cloud API key used against AI Studio | Re-paste the key from aistudio.google.com/apikey; use `npx wrangler secret put` (no quotes needed) |
| `429` after ~a dozen messages | Free-tier Gemini quota, or a shared IP hitting the limiter | Expected. Raise `RATE_LIMIT_PER_MINUTE` only if it's your own abuse, otherwise add billing to the provider. Visitors get "wait a few seconds", not a crash |
| `429` "Too many requests from your network" with a `retry-after` | Realm AI's own limiter | That's `RATE_LIMIT_PER_MINUTE` (default 20/min per visitor IP). Set `0` to disable (not recommended on a public site) |
| Replies are empty for long/complex asks | Output capped mid-answer | Raise `GEMINI_MAX_TOKENS` (default 2048) or set `GEMINI_THINKING_BUDGET=0` so thinking models don't spend the budget on reasoning |
| Works in Chrome, not in Firefox/Safari | Nothing Realm-specific: voice input (`startVoice`) is Web Speech API and unsupported in Firefox | Feature-detect already shows a toast; don't wire anything else to it |
| Local `npm run dev` chat fails with "Could not reach the AI provider" | Sandbox/offline network or a corporate proxy intercepting `generativelanguage.googleapis.com` | Test the proxy path with `GEMINI_BASE_URL`; `502 BAD_PROVIDER_REPLY` now says exactly this instead of faking an empty answer |
| `Unexpected token '<' ... is not valid JSON` in the console | The API path is being answered by **static hosting** (it returns HTML) | Workers: needs `run_worker_first: ["/api/*"]`. Pages: `functions/api/chat.js` must exist at the repo root (not in `public/`). The frontend now detects this and says "backend is not connected" |
| Visitors can use my quota without limit | The API is public by design (no accounts yet) | Keep `RATE_LIMIT_PER_MINUTE` on; bind `RATE_LIMIT_KV` for an exact count; wire Supabase Auth (Sprint C) and add a per-user budget check in `shared/api.js` |

## Payments (Paddle)

| Symptom | Cause | Fix |
|---|---|---|
| "Pricing is unavailable: …" | Old behaviour: a thrown error inside the render loop (reading `formattedTotals`, which Paddle never returns) or a hard fail when config was missing | Fixed: preview plans render instead. If you still see it, read the sentence — it names the exact missing piece |
| Prices show `$5 / $15 / $25` forever | `public/tiers.js` still has `pri_REPLACE_ME` | Put real price IDs there (`pri_` + 26 chars). No other change needed |
| `Paddle.js did not load` | Ad blocker, or a CSP without `cdn.paddle.com` | Allow the CDN; if you add the CSP from `public/_headers`, include `script-src https://cdn.paddle.com` and `frame-src https://cdn.paddle.com https://sandbox-checkout.paddle.com https://checkout.paddle.com` |
| Checkout iframe is blank / refused | Domain not approved in Paddle | Paddle → Checkout → Website approval → add the live domain (sandbox needs it too) |
| Displayed price ≠ checkout price | Country guessing differs between page and checkout | Both use the same `country` from `/api/paddle-config` (Cloudflare `cf-ipcountry`); if a visitor is on a VPN, the checkout country wins |
| `500 PADDLE_TOKEN_MISMATCH` | `test_…` token with `PADDLE_ENV=production` (or the reverse) | Match them; sandbox tokens start `test_`, live ones `live_` |
| Paddle notifications: `401 Invalid webhook signature` | Wrong `PADDLE_WEBHOOK_SECRET`, or the endpoint uses SHA-1, or the body was parsed before verifying (never do that) | Copy the signing secret again; set the notification's algorithm to **SHA-256**; keep using `handleApi` which clones the request for verification |
| Paddle retries the webhook forever | Endpoint returning 5xx (e.g. Supabase down) | Verify with the curl snippet in `PADDLE.md`; `503 WEBHOOK_NOT_CONFIGURED` means the secret is missing |
| "Plan not activated after paying" | By design until accounts exist | See `NEXT_STEPS.md` Sprint C; the webhook journals events so nothing is lost meanwhile |

## Cloudflare build / CI

| Symptom | Cause | Fix |
|---|---|---|
| Build fails: `Could not resolve "../../shared/api.js"` | Import depth in a Pages Function; `functions/api/paddle/webhook.js` needs `../../../` | `npm run check` now resolves every relative import before you push |
| Build fails: `Could not resolve "./worker/index.js"` or "entry-point file not found" | `main` in `wrangler.json` vs actual file | Keep `"main": "worker/index.js"` |
| Build fails: `Pages Functions build failed: ... expected onRequest export` | A file in `functions/` is a helper, not a route | Move shared code out of `functions/` (this repo keeps it in `shared/`) |
| CI: `npm ci` error "lock file was not created with --package-lock-only" / missing lock | `package-lock.json` not committed | Commit it (it is, here) |
| CI: red ❌ with 3 yellow warnings | Warnings about `YOUR-DOMAIN` / `pri_REPLACE_ME` don't fail the build | They're reminders; they disappear once you set a domain and price IDs |
| Worker logs full of `Unable to fetch the Request.cf object` | Local dev without network access to Cloudflare | Harmless; only affects `request.cf.country` (Paddle then auto-detects) |
| `npx wrangler deploy` asks to create the worker / errors 10089 | No `CLOUDFLARE_API_TOKEN` or not logged in | `npx wrangler login`, or set the token in CI |

## Agent mode

| Symptom | Cause | Fix |
|---|---|---|
| Agent says "The AI backend is not connected yet" | same single secret as chat (`GEMINI_API_KEY`) on the host serving the page | `curl -s https://SITE/api/health` — `ai.configured` decides everything here |
| A step fails and says `Step 2 failed: …` | that one model call errored (quota, timeout, blocked) | earlier steps are kept on screen; press Run again — the plan is re-made, but you can also just retry by re-running |
| `FUNCTION_TIMEOUT` in Netlify logs instead of a message in the UI | a single request outlived 26 s | don't merge the phases back into one call; keep `PROVIDER_TIMEOUT_MS` (default 21000 on Netlify) below the ceiling |
| Plan step cards stay on "Checking the result against the goal…" | the verify call is the longest one (it re-reads every step) | expected on long runs; shorten the goal, or lower `GEMINI_MAX_TOKENS` |
| Plan text appears as one blob with a "fallback" note | the model returned prose instead of JSON | harmless: `parseJsonObject` recovers prose into one usable step; set `GEMINI_MODEL` to a stronger model if you want real multi-step plans |
| Stop does nothing mid-request | Stop applies after the current step (the request can't be cancelled safely server-side) | by design — you keep the results of finished steps |

## Netlify (if that host is still in use)

| Symptom | Cause | Fix |
|---|---|---|
| `/` is 404 on Netlify but fine on workers.dev | the site publishes the repo root | `netlify.toml` pins `publish = "public"`; commit it and redeploy |
| `404 function not found` on `/api/chat` | the `/api/*` redirect is missing, or the function didn't build | keep `[[redirects]] from = "/api/*"` and `node_bundler = "esbuild"` in `netlify.toml`; check the deploy log for the function listing |
| Chat works on one host, not the other | secrets only exist in one provider | set `GEMINI_API_KEY` on the host that serves visitors (see `CLOUDFLARE.md` section C) |
| Visitors are asked to sign in to Netlify | Deploy preview / site password protection | Site settings → Access & security → disable protection for public sites |

## Still stuck?

```bash
npm run dev:mock       # no key needed: chat + agent against a local mock provider (:8787)
npm run dev            # Worker + assets on :8787, same code as production
npm run dev:pages      # Pages Functions variant on :8788
npm test               # 31 logic tests for the API layer
npx wrangler tail        # live logs of the deployed Worker
curl -si -X POST https://YOUR-SITE/api/chat -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"ping"}]}'
```

If that curl returns `{"error":"AI is not connected yet...","code":"AI_NOT_CONFIGURED"}`, the deploy is
correct and only the secret is missing. If it returns HTML, the API route isn't part of the deployment.
