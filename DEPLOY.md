# Realm AI deployment path

## Fastest public preview
Use Cloudflare Pages to publish the static frontend. For a first public link, the project can use a Cloudflare Pages URL; a custom domain can be connected later.

### Deploy
- Create a Cloudflare account.
- Create a Pages project.
- Upload the `realm-ai-v1` frontend or connect a Git repository.
- Set the output directory to the project root for this plain HTML build.
- Publish.

## Production architecture
Browser → Cloudflare Worker → Supabase / AI provider / payment provider

Keep all provider secrets in server-side environment variables.

## AI
The current frontend uses a model-agnostic interface. Connect your chosen model provider inside the Worker; do not put API keys into the page.

## Files
The current upload control previews selected files locally. Production file processing should upload to authenticated storage and perform parsing server-side with size/type limits.

## Payments
The pricing screen is ready for a server-side checkout flow. For JazzCash, obtain the appropriate business/online-gateway merchant credentials and test with the sandbox before enabling production charges. Payment confirmation should be verified on the server before a paid subscription is activated.

## Domain + search
After publishing, connect a custom domain, add sitemap/robots metadata, verify the property in Google Search Console, and submit the sitemap. Search indexing and ranking are not instant or guaranteed.
