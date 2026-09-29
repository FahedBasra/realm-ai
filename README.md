# Realm AI: setup guide

## 1. AI backend (Gemini)
1. Create an API key at aistudio.google.com
2. Upload every file in this folder to a GitHub repo (keep the functions/ folder)
3. Cloudflare Pages > Create project > Connect to Git. Build command: none. Output directory: /
4. Settings > Variables and Secrets: add GEMINI_API_KEY (as a Secret). Optional: GEMINI_MODEL
5. Redeploy

## 2. Payments (Paddle only)
1. Create a sandbox account at sandbox-login.paddle.com
2. Catalog > create 3 products with monthly recurring prices: Starter $5, Pro $15, Ultimate $25. Copy each price ID (pri_...)
3. Developer tools > Authentication > create a client-side token (starts with test_)
4. In index.html edit PADDLE={...}: paste the token and the 3 price IDs. Keep env:'sandbox' while testing
5. Add your site domain in Paddle > Checkout > Website approval if the checkout does not open
6. To go live: create a live Paddle account, then set env:'live' and use the live token and price IDs
7. In index.html edit SALES={email:''} with the address that should receive Enterprise enquiries

## 3. Search visibility
Replace YOUR-DOMAIN in index.html, robots.txt and sitemap.xml with your live address, then add the site to Google Search Console and submit sitemap.xml.
