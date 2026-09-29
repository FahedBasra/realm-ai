/* Realm AI — plans shown on the pricing page.
 *
 * EDIT THIS FILE to change plans. `priceId.month` / `priceId.year` come from
 * Paddle > Catalog > Products > your product > price ID (looks like pri_01abc...).
 * Fill both, then the pricing page switches from "preview" mode to real, localized
 * prices and a working Subscribe button automatically — no other code changes needed.
 *
 * `fallback` is display-only: it is what visitors see while priceIds are still
 * REPLACE_ME, so the page never shows a scary error during setup. No money moves
 * until Paddle is configured in Cloudflare (see README.md step 2).
 *
 * interface Tier { name: string; description: string; features: string[];
 *                  highlight?: boolean; priceId: { month: string; year: string };
 *                  fallback: { month: string; year: string } }
 */
window.REALM_TIERS = [
  { name: 'Starter', description: 'For everyday AI help.',
    features: ['Everyday AI chat', 'Higher daily limits', 'Text file analysis', 'Image generator', 'Saved chat history'],
    priceId: { month: 'pri_REPLACE_ME', year: 'pri_REPLACE_ME' },
    fallback: { month: '$5', year: '$50' } },
  { name: 'Pro', description: 'For power users and builders.', highlight: true,
    features: ['Everything in Starter', 'Much higher usage', 'AI Agent mode', 'Code Assistant', 'Faster responses'],
    priceId: { month: 'pri_REPLACE_ME', year: 'pri_REPLACE_ME' },
    fallback: { month: '$15', year: '$150' } },
  { name: 'Advanced', description: 'For heavy, advanced workflows.',
    features: ['Everything in Pro', 'Highest usage limits', 'Advanced agent workflows', 'Early access to new features', 'Priority support'],
    priceId: { month: 'pri_REPLACE_ME', year: 'pri_REPLACE_ME' },
    fallback: { month: '$25', year: '$250' } }
];
