#!/usr/bin/env node
/**
 * Send a correctly signed Paddle notification to a local Realm AI dev server, so the webhook path
 * (verify → log → activate) can be watched without a Paddle account or a tunnel.
 *
 *   npm run mock:webhook                    # transaction.paid (pro, $15)
 *   node scripts/mock-webhook.mjs --url http://127.0.0.1:8787/api/paddle/webhook --secret trl_local
 *   node scripts/mock-webhook.mjs --event subscription.canceled
 *
 * Needs PADDLE_WEBHOOK_SECRET=<the same --secret> on the server (npm run dev:mock sets trl_local).
 */
import { createHmac } from 'node:crypto';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const url = arg('url', 'http://127.0.0.1:8787/api/paddle/webhook');
const secret = arg('secret', 'trl_local');
const event = arg('event', 'transaction.paid');
const txnId = arg('txn', 'txn_' + 'a'.repeat(26));
const subId = arg('sub', 'sub_' + 'a'.repeat(26));
const email = arg('email', 'buyer@example.com');

const events = {
  'transaction.paid': {
    id: txnId, status: 'paid', currency_code: 'USD', customer_id: 'ctm_demo', customer_email: email,
    custom_data: { tier: 'pro', billing: 'month' }, details: { totals: { grand_total: '15.00', tax: '0.00' } },
    subscription_id: subId, updated_at: new Date().toISOString()
  },
  'transaction.billed': {
    id: txnId, status: 'ready', currency_code: 'USD', customer_id: 'ctm_demo', customer_email: email,
    custom_data: { tier: 'pro', billing: 'year' }, details: { totals: { grand_total: '150.00', tax: '0.00' } }
  },
  'subscription.canceled': {
    id: subId, status: 'canceled', customer_id: 'ctm_demo', customer_email: email, custom_data: { tier: 'pro' }, items: []
  },
  'payment_failed': {
    id: 'pay_' + 'a'.repeat(26), status: 'failed', customer_id: 'ctm_demo', subscription_id: subId,
    amount: '15.00', currency_code: 'USD', attempt: 1, available_payment_methods: []
  }
};
const data = events[event];
if (!data) {
  console.error(`unknown event "${event}". Try: ${Object.keys(events).join(', ')}`);
  process.exit(1);
}
const body = JSON.stringify({ event_id: 'evt_' + Math.random().toString(36).slice(2, 12), event_type: event, occurred_at: new Date().toISOString(), data });
const ts = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');

try {
  const res = await fetch(url, {
    method: 'POST', body, signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};v1=${v1}` }
  });
  console.log(`${res.status} ${res.ok ? '✓ accepted' : '✗ refused'}  ${event}`);
  console.log((await res.text()).trim() || '(empty body)');
  if (!res.ok) {
    if (res.status === 401) console.log('  → 401 means the server\'s PADDLE_WEBHOOK_SECRET differs from --secret, or the clock is off by >5 min.');
    if (res.status === 503) console.log('  → 503: no PADDLE_WEBHOOK_SECRET on the server. Run `npm run dev:mock`.');
    process.exitCode = 1;
  }
} catch (error) {
  const why = /timeout|abort/i.test(String(error?.name + error?.message)) ? 'it accepted the connection but never answered (a restarting dev server does that)' : error.message;
  console.error(`could not reach ${url}\n  ${why}\n  Start the dev server first: npm run dev:mock`);
  process.exitCode = 1;
}
