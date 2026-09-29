/* Realm AI — pricing + Paddle checkout.
 *
 * Uses Paddle.js v2 (loaded in index.html; same API as the @paddle/paddle-js npm package).
 * Environment, client-side token and the visitor's country come from the backend route
 * GET /api/paddle-config — nothing secret or environment-specific is hard-coded here.
 *
 * Behaviour while setup is incomplete (this is deliberate, not a bug):
 *   - Paddle price IDs missing  -> cards render with the display-only fallback price and a
 *                                  "billing is being set up" note; buttons are disabled.
 *   - /api/paddle-config 404    -> static hosting only (no Pages Function / Worker route);
 *                                  same preview state, plus a one-line hint.
 *   - Paddle.js blocked by an extension or CSP -> same preview state.
 * Once Paddle is configured and the price IDs in tiers.js are real, prices come from Paddle
 * (localized, taxes included) and Subscribe opens Paddle Checkout.
 */
(function () {
  'use strict';
  const root = document.getElementById('pricingRoot');
  if (!root) return;

  let cycle = 'month';
  const prices = {};          // priceId -> Paddle line item
  let country = null;
  let setupNote = '';

  const tierList = () => (Array.isArray(window.REALM_TIERS) ? window.REALM_TIERS : []);
  const isRealPriceId = (id) => /^pri_[a-z0-9]{26}$/.test(String(id || ''));
  const userEmail = () => (window.REALM_USER && window.REALM_USER.email) || null; // set window.REALM_USER after login

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Paddle returns formatted totals; accept both camelCase spellings just in case. */
  function formatted(li) {
    if (!li) return null;
    const cost = li.cost || {};
    const totals = li.formattedTotals || {};
    return cost.formatted || cost.formattedTotal || totals.total || null;
  }

  /** Wait for the async Paddle.js <script> to finish, up to `ms`. */
  function waitForPaddle(ms) {
    return new Promise(function (resolve) {
      if (window.Paddle) return resolve(true);
      const started = Date.now();
      const t = setInterval(function () {
        if (window.Paddle) { clearInterval(t); resolve(true); }
        else if (Date.now() - started > ms) { clearInterval(t); resolve(false); }
      }, 50);
    });
  }

  function notice(msg) {
    if (!msg) return null;
    return el('div', 'notice', msg);
  }

  function render() {
    if (!tierList().length) {
      root.textContent = '';
      root.appendChild(notice('No plans are defined yet — add them to public/tiers.js.'));
      return;
    }
    root.textContent = '';
    root.appendChild(notice(setupNote));

    const tog = el('div', 'billtoggle');
    [['month', 'Monthly'], ['year', 'Yearly']].forEach(function (pair) {
      const b = el('button', pair[0] === cycle ? 'on' : '', pair[1]);
      b.type = 'button';
      b.onclick = function () { cycle = pair[0]; render(); };
      tog.appendChild(b);
    });
    root.appendChild(tog);

    const grid = el('div', 'plans plans3');
    tierList().forEach(function (t) {
      const id = (t.priceId || {})[cycle];
      const live = prices[id];
      const card = el('div', 'card plan' + (t.highlight ? ' pro' : ''));
      if (t.highlight) card.appendChild(el('span', 'popular', 'POPULAR'));
      card.appendChild(el('h3', null, t.name || 'Plan'));
      card.appendChild(el('p', null, t.description || ''));

      const priceText = formatted(live) || (t.fallback && t.fallback[cycle]) || '—';
      const pr = el('div', 'price', priceText);
      pr.appendChild(el('span', 'per', ' / ' + (cycle === 'month' ? 'month' : 'year')));
      card.appendChild(pr);

      const ul = el('ul');
      (t.features || []).forEach(function (f) { ul.appendChild(el('li', null, f)); });
      card.appendChild(ul);

      const btn = el('button', t.highlight ? 'primary' : 'secondary');
      btn.style.width = '100%';
      btn.type = 'button';
      if (live) {
        btn.textContent = 'Subscribe';
        btn.disabled = false;
        btn.onclick = function () { subscribe(t, id); };
      } else {
        btn.textContent = 'Coming soon';
        btn.disabled = true;
        btn.title = setupNote || 'Billing is not connected yet.';
      }
      card.appendChild(btn);
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  function subscribe(t, priceId) {
    if (!window.Paddle) return;
    const customer = {};
    const email = userEmail();
    if (email) customer.email = email;
    if (country) customer.address = { countryCode: country };   // keeps checkout price == displayed price
    Paddle.Checkout.open({
      items: [{ priceId: priceId, quantity: 1 }],
      customData: { tier: t.name, billing: cycle },
      customer: Object.keys(customer).length ? customer : undefined,
      settings: {
        displayMode: 'overlay',
        variant: 'one-page',
        theme: 'dark',
        // welcome.html is a real file in public/, so this works on Pages and on the Worker.
        successUrl: location.origin + '/welcome.html'
      }
    });
  }

  /** Ask Paddle for localized totals for every price id we intend to display. */
  async function previewPrices() {
    const ids = [...new Set(tierList().flatMap((t) => [(t.priceId || {}).month, (t.priceId || {}).year]).filter(isRealPriceId))];
    if (!ids.length) return;
    const request = { items: ids.map((priceId) => ({ priceId, quantity: 1 })) };
    if (country) request.address = { countryCode: country };
    try {
      const res = await Paddle.PricePreview(request);
      const details = res && res.data && res.data.details;
      const items = (details && (details.lineItems || details.line_items)) || [];
      items.forEach(function (li) {
        const id = li && li.price && (li.price.id || li.priceId);
        if (id) prices[id] = li;
      });
      if (details && details.countryCode) country = details.countryCode;
    } catch (e) {
      setupNote = 'Live prices are unavailable right now (' + (e && e.message ? e.message : e) + '). Showing preview prices.';
    }
  }

  async function init() {
    root.textContent = 'Loading prices…';

    // 1. Paddle.js may still be loading, or blocked (extension, strict CSP, offline CDN).
    if (!(await waitForPaddle(3000))) {
      setupNote = 'Paddle.js did not load (ad blocker or script blocked?), so plans are shown in preview mode.';
      render();
      return;
    }
    // 2. Backend config. A 404/405 here means only static hosting is deployed.
    let cfg = null;
    try {
      const r = await fetch('/api/paddle-config', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const ct = r.headers.get('content-type') || '';
      // A 200 with HTML means static hosting answered instead of the API route.
      if (ct.indexOf('json') === -1) cfg = { error: '/api/paddle-config is not deployed on this origin (static hosting only).' };
      else cfg = await r.json().catch(() => ({ error: 'Paddle config reply could not be read.' }));
    } catch (e) {
      setupNote = 'Billing config could not be reached (/api/paddle-config), so plans are in preview mode.';
      render();
      return;
    }
    if (!cfg || !cfg.clientToken) {
      setupNote = cfg && cfg.error
        ? 'Billing is not connected yet: ' + cfg.error
        : 'Billing is not connected yet, so plans are shown in preview mode.';
      render();
      return;
    }
    if (cfg.environment === 'sandbox' && Paddle.Environment) Paddle.Environment.set('sandbox');
    country = cfg.country || null;
    try {
      Paddle.Initialize({ token: cfg.clientToken });
    } catch (e) {
      setupNote = 'Paddle could not initialize with the client-side token (' + (e && e.message ? e.message : e) + ').';
      render();
      return;
    }
    // 3. Price IDs in tiers.js decide whether we can go live at all.
    const pending = tierList().some((t) => !isRealPriceId((t.priceId || {}).month) || !isRealPriceId((t.priceId || {}).year));
    await previewPrices();
    if (pending) {
      setupNote = 'Paddle is connected. Put your real price IDs in public/tiers.js and the Subscribe buttons activate automatically — until then this page is preview only.';
    }
    render();
  }

  init();
})();
