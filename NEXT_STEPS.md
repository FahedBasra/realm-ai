# Realm AI — Next Steps

## Sprint A: publish the current website
1. Create a GitHub repository named `realm-ai`.
2. Upload the contents of this folder, keeping `index.html` at the repository root.
3. In Cloudflare, create a Pages project and import the GitHub repository.
4. Production branch: `main`.
5. Build command: `exit 0`.
6. Build output directory: `.` (repository root).
7. Deploy. Cloudflare will provide a `pages.dev` URL.

## Sprint B: connect real AI
Use a server-side AI endpoint. Never put an AI API key in `index.html` or client-side JavaScript.
Recommended first provider: Google AI Studio/Gemini Free Tier, subject to current model rate limits.

Flow:
Browser -> Cloudflare backend -> Gemini/API provider -> Browser

## Sprint C: account + data
Create a Supabase project and connect:
- Auth: signup/login/logout
- Database: profiles, conversations, messages, subscriptions, payments, usage
- Storage: uploaded files

## Sprint D: files
Current frontend supports choosing and dropping common files. Production version should upload them to authenticated storage, scan/validate them, extract text where appropriate, and send only authorized content to the model backend.

## Sprint E: agents
Add a server-side agent runner with:
- planner
- approved tools
- tool permissions
- execution log
- result verification
- final response

## Sprint F: payments
Apply for an approved JazzCash merchant/online-payment setup. Put merchant credentials only in backend secrets. Build the flow as:
checkout -> provider -> verified callback/webhook -> payment record -> subscription activation.

Do not collect or store customer card CVV/PIN in Realm AI.

## Sprint G: launch
Before public launch:
- replace placeholder sitemap domain
- replace privacy/terms placeholders with appropriate legal text
- add custom domain
- add analytics/monitoring as appropriate
- test mobile, upload limits, auth, billing, rate limits and error handling
