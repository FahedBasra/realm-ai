# Realm AI — Premium Frontend Foundation

Realm AI is a polished AI-workspace frontend designed to grow into a real assistant + agent SaaS product.

## Included now
- Premium dark SaaS visual system and responsive layout
- Branded Realm AI logo
- Home / command-center dashboard
- Chat workspace with conversation sidebar
- File upload UI with click-to-browse and drag/drop preview
- AI Agent workspace and execution pipeline UI
- Image Generator workspace
- Code Assistant workspace
- Knowledge Base workspace
- History workspace
- Plans & Billing UI
- Secure-payment guidance (no card/CVV/PIN/API secrets in browser)
- Settings workspace
- Mobile-friendly navigation foundation

## Not yet live
The interface is intentionally separated from production secrets and external services. Real AI model calls, authenticated accounts, persistent chat history, secure file storage, real agent tool execution, and live JazzCash merchant checkout require backend credentials and service configuration.

## Next production connections
1. Supabase Auth + database
2. Cloudflare Worker API
3. Server-side AI model provider
4. Authenticated object storage for files
5. Agent tool permissions and execution
6. JazzCash merchant/sandbox integration, then live approval
7. Domain + Cloudflare deployment
8. Search indexing / SEO

## Security rule
Never place a JazzCash merchant secret, API key, card number, CVV, PIN, or private customer file in `index.html` or any other public frontend asset.
