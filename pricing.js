/* Pricing + Paddle checkout. Uses Paddle.js v2 (loaded from CDN in index.html; same API as @paddle/paddle-js).
 * Environment, token and country come from the Worker (/api/paddle-config). Nothing is hard-coded or defaulted. */
(function () {
  const root = document.getElementById('pricingRoot');
  if (!root) return;
  let cycle = 'month', prices = {}, ready = false;

  function fail(msg) {
    console.error('[pricing] ' + msg);
    root.textContent = '';
    const n = document.createElement('div');
    n.className = 'notice'; n.style.textAlign = 'center';
    n.textContent = 'Pricing is unavailable: ' + msg;
    root.appendChild(n);
  }
  const userEmail = () => (window.REALM_USER && window.REALM_USER.email) || null; // set window.REALM_USER after login

  function render(country) {
    root.textContent = '';
    const tog = document.createElement('div'); tog.className = 'billtoggle';
    [['month', 'Monthly'], ['year', 'Yearly']].forEach(([c, label]) => {
      const b = document.createElement('button'); b.textContent = label;
      b.className = c === cycle ? 'on' : ''; b.onclick = () => { cycle = c; render(country); };
      tog.appendChild(b);
    });
    root.appendChild(tog);
    const grid = document.createElement('div'); grid.className = 'plans plans3';
    window.REALM_TIERS.forEach(t => {
      const id = t.priceId[cycle], p = prices[id];
      const card = document.createElement('div'); card.className = 'card plan' + (t.highlight ? ' pro' : '');
      if (t.highlight) { const s = document.createElement('span'); s.className = 'popular'; s.textContent = 'POPULAR'; card.appendChild(s); }
      const h = document.createElement('h3'); h.textContent = t.name; card.appendChild(h);
      const d = document.createElement('p'); d.style.cssText = 'color:#91a0bb;font-size:12px;margin:0 0 6px'; d.textContent = t.description; card.appendChild(d);
      const pr = document.createElement('div'); pr.className = 'price';
      pr.textContent = p ? p.formattedTotals.total : '—';            // Paddle's string, untouched
      const per = document.createElement('span'); per.className = 'per'; per.textContent = ' / ' + (cycle === 'month' ? 'month' : 'year');
      pr.appendChild(per); card.appendChild(pr);
      const ul = document.createElement('ul'); t.features.forEach(f => { const li = document.createElement('li'); li.textContent = f; ul.appendChild(li); }); card.appendChild(ul);
      const btn = document.createElement('button'); btn.className = t.highlight ? 'primary' : 'secondary'; btn.style.width = '100%';
      btn.textContent = 'Subscribe'; btn.disabled = !p; btn.onclick = () => subscribe(t, id, country);
      card.appendChild(btn); grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  function subscribe(t, priceId, country) {
    const email = userEmail();
    const customer = {};
    if (email) customer.email = email;
    if (country) customer.address = { countryCode: country };        // keep checkout price = displayed price
    Paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customData: { tier: t.name, billing: cycle },
      ...(Object.keys(customer).length ? { customer } : {}),
      settings: { displayMode: 'overlay', variant: 'one-page', theme: 'dark', successUrl: location.origin + '/welcome' }
    });
  }

  (async function init() {
    root.textContent = 'Loading prices…';
    let cfg;
    try {
      const r = await fetch('/api/paddle-config', { cache: 'no-store' });
      cfg = await r.json().catch(() => ({}));
      if (!r.ok) return fail(cfg.error || ('config request failed (' + r.status + ')'));
    } catch (e) { return fail('could not reach /api/paddle-config'); }
    if (!window.Paddle) return fail('Paddle.js did not load (ad blocker?)');
    const tiers = window.REALM_TIERS || [];
    const ids = tiers.flatMap(t => [t.priceId.month, t.priceId.year]);
    if (!ids.length || ids.some(i => !/^pri_/.test(i) || /REPLACE/.test(i))) return fail('set real Paddle price IDs in public/tiers.js');
    if (cfg.environment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({ token: cfg.clientToken });
    const country = cfg.country || undefined;                        // absent => Paddle detects from IP
    try {
      const res = await Paddle.PricePreview({
        items: [...new Set(ids)].map(priceId => ({ priceId, quantity: 1 })),
        ...(country ? { address: { countryCode: country } } : {})
      });
      res.data.details.lineItems.forEach(li => { prices[li.price.id] = li; });
    } catch (e) { return fail('Paddle price preview failed: ' + (e && e.message ? e.message : e)); }
    ready = true; render(country);
  })();
})();
