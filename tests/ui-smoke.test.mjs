#!/usr/bin/env node
/**
 * Realm AI — UI smoke test (jsdom, no browser, no network).
 *
 * Boots the real public/index.html with its real <script src="/tiers.js"> / "/pricing.js" tags,
 * stubs fetch() with the responses a fresh Cloudflare deployment returns, and asserts that:
 *   - nothing throws while the page boots (the class of bug that leaves a blank site)
 *   - the pricing section degrades to preview plans instead of an error box
 *   - the chat's backend fallback logic picks the right path (503 AI_NOT_CONFIGURED → dev key)
 *   - Settings fields no longer overwrite each other (display name used to be saved as the model name)
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(root, 'public');

const json = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
  json: async () => obj,
  text: async () => JSON.stringify(obj)
});

const openedCheckouts = [];
const calls = [];
const agentCalls = [];
let agentMode = 'ok';

function makeFetch({ aiConfigured = true } = {}) {
  return async function fetchStub(url, opts = {}) {
    const u = String(url);
    calls.push({ url: u, body: opts.body });
    if (u.includes('/api/health')) {
      return json({
        ok: true, service: 'realm-ai', version: 'v3',
        ai: { configured: aiConfigured, model: 'gemini-2.5-flash-lite' },
        billing: { paddleConfigured: false, environment: null, tokenMatchesEnv: false, webhookConfigured: false, eventLogConfigured: false },
        limits: { requestsPerMinute: 20 }
      });
    }
    if (u.includes('/api/agent')) {
      if (agentMode === 'off') return json({ error: 'AI is not connected yet.', code: 'AI_NOT_CONFIGURED' }, 503);
      const body = opts.body ? JSON.parse(opts.body) : {};
      agentCalls.push(body.phase);
      if (body.phase === 'plan') return json({ phase: 'plan', deliverable: 'A study plan', missing: '', steps: [{ id: 0, title: 'Collect constraints', detail: 'what matters' }, { id: 1, title: 'Draft the week', detail: 'day by day' }, { id: 2, title: 'Check gaps', detail: 'list what is missing' }] });
      if (body.phase === 'step') {
        if (agentMode === 'slowstep' && body.stepIndex === 1) return json({ error: 'Step failed upstream.', code: 'PROVIDER_ERROR' }, 502);
        if (agentMode === 'cancel') await new Promise((r) => setTimeout(r, 120));
        return json({ phase: 'step', index: body.stepIndex, output: 'Output for step ' + (Number(body.stepIndex) + 1) + ': ' + (body.steps[body.stepIndex]?.title || '') });
      }
      return json({ phase: 'verify', verdict: 'complete', gaps: [], final: '# Study plan\n\nDay 1: revise.\n\n**Verified against the goal.**' });
    }
    if (u.includes('/api/paddle-config')) return json({ error: 'Billing is not configured yet. Set PADDLE_ENV and PADDLE_CLIENT_TOKEN as secrets.', code: 'PADDLE_NOT_CONFIGURED' }, 503);
    if (u.includes('/api/chat')) return json({ error: 'AI is not connected yet. Add GEMINI_API_KEY as a secret in Cloudflare and redeploy.', code: 'AI_NOT_CONFIGURED' }, 503);
    if (u.includes('generativelanguage.googleapis.com')) {
      return json({ candidates: [{ content: { parts: [{ text: 'Direct-key reply from the model.' }], role: 'model' }, finishReason: 'STOP' }], modelVersion: 'gemini-2.5-flash-lite' });
    }
    if (u.includes('pollinations')) return json({ unexpectedImageApi: true }, 500);
    return json({ error: 'unexpected request in test: ' + u }, 500);
  };
}

/**
 * jsdom is run without a resource loader, so same-origin <script src="/x.js"> tags are inlined from disk
 * here. The Paddle CDN tag is intentionally left alone: it stays unloaded, exactly like an ad blocker
 * would leave it, and pricing.js must survive that.
 */
function pageHtml() {
  return fs
    .readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace(/<script src="\/(tiers|pricing)\.js"><\/script>/g, (_m, name) => `<script>${fs.readFileSync(path.join(PUB, name + '.js'), 'utf8')}</script>`);
}

async function boot({ withLocalKey = false, aiConfigured = !withLocalKey } = {}) {
  const problems = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => problems.push(`jsdom: ${e.message}`));
  vc.on('error', (...a) => problems.push(`console.error: ${a.join(' ')}`));

  const dom = new JSDOM(pageHtml(), {
    url: 'https://realm.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = makeFetch({ aiConfigured });
      window.scrollTo = () => {};
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      // A stand-in for Paddle.js so pricing.js exercises its real code path.
      window.Paddle = {
        Environment: { set(v) { window.__paddleEnv = v; } },
        Initialize(o) { window.__paddleToken = o.token; },
        async PricePreview() { throw new Error('sandbox has no configured prices'); },
        Checkout: { open(o) { openedCheckouts.push(o); } }
      };
      if (withLocalKey) window.localStorage.setItem('realm_gemini_key', 'AIzaFAKE_LOCAL_TEST_KEY');
      window.localStorage.setItem('realm_settings_v1', JSON.stringify({ name: 'Fahed', assistant: 'Realm AI', style: 'Concise' }));
    }
  });

  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', resolve, { once: true });
    setTimeout(resolve, 2500);
  });
  return { dom, window: dom.window, document: dom.window.document, problems };
}

const waitFor = async (fn, ms = 2500) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { if (fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

let passed = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.error(`  ✖ ${name}${extra ? `\n    ${extra}` : ''}`); }
};

console.log('\nboot');
const { window, document, problems } = await boot();
check('page boots with no script errors', problems.length === 0, problems.join('\n    '));
check('tiers are registered', Array.isArray(window.REALM_TIERS) && window.REALM_TIERS.length === 3, `REALM_TIERS=${JSON.stringify(window.REALM_TIERS)}`);
check('tiers.js loads before pricing.js', htmlOrderOk(), 'see index.html bottom');
function htmlOrderOk() {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const t = html.indexOf('src="/tiers.js"');
  const p = html.indexOf('src="/pricing.js"');
  return t > -1 && p > t;
}

console.log('\npricing section (Paddle not configured → preview mode, never an error box)');
const pricingOk = await waitFor(() => document.querySelectorAll('#pricingRoot .plan').length === 3);
check('three plan cards render', pricingOk);
const pro = [...document.querySelectorAll('#pricingRoot .plan')].find((c) => /Pro/.test(c.textContent));
check('Pro shows the fallback price, not NaN/undefined', pro && /\$15/.test(pro.textContent), pro && pro.textContent.slice(0, 120));
check('no "Pricing is unavailable" error text', !/unavailable/i.test(document.getElementById('pricingRoot').textContent), document.getElementById('pricingRoot').textContent.slice(0, 160));
check('subscribe buttons are disabled until price ids are real', [...document.querySelectorAll('#pricingRoot .plan button')].every((b) => b.disabled && /Coming soon/.test(b.textContent)));
check('setup hint explains the next step', /not connected yet/i.test(document.getElementById('pricingRoot').textContent));
const toggles = [...document.querySelectorAll('#pricingRoot .billtoggle button')];
check('monthly/yearly toggle exists', toggles.length === 2);
toggles[1]?.click();
await new Promise((r) => setTimeout(r, 50));
check('yearly toggle re-renders yearly fallback price', /\$150/.test(document.getElementById('pricingRoot').textContent));
toggles[0]?.click();

console.log('\nbackend status strip in Settings');
const statusOk = await waitFor(() => /AI:/.test(document.getElementById('backendStatus')?.textContent || ''));
check('/api/health is surfaced to the user', statusOk, document.getElementById('backendStatus')?.textContent);
check('a configured backend is reported as connected', /connected/.test(document.getElementById('backendStatus').textContent), document.getElementById('backendStatus').textContent);
check('says pricing is in preview while Paddle is unset', /Paddle not configured/.test(document.getElementById('backendStatus').textContent));

console.log('\nsettings fields (regression: display name used to be written into the model field)');
const nameField = document.getElementById('displayName');
const modelField = document.getElementById('gModel');
const assistantField = document.getElementById('assistantName');
check('display name is read from its own input', nameField.value === 'Fahed', `displayName="${nameField?.value}"`);
check('assistant name is read from its own input', assistantField.value === 'Realm AI');
check('the Gemini model input is NOT the display name', modelField.value !== 'Fahed', `gModel="${modelField?.value}"`);
nameField.value = 'Ayesha';
modelField.value = 'gemini-2.5-flash';
window.savePrefs();
check('saving keeps the model in its own key', window.localStorage.getItem('realm_gemini_model') === 'gemini-2.5-flash', window.localStorage.getItem('realm_gemini_model'));
check('saving does not invent a model named after the user', JSON.parse(window.localStorage.getItem('realm_settings_v1')).name === 'Ayesha');
check('the profile chip follows the display name', [...document.querySelectorAll('.profile-name')].every((n) => n.textContent === 'Ayesha'));

console.log('\nchat: backend + fallback decision making');
document.getElementById('prompt').value = 'Summarise this for me';
window.sendMsg();
const errored = await waitFor(() => /not connected yet/i.test(document.getElementById('messages').textContent));
check('without a backend and without a local key it explains the fix', errored, document.getElementById('messages').textContent.slice(-200));
check('the system instruction is sent to the backend', JSON.parse(calls.filter((c) => c.url.includes('/api/chat')).pop().body).messages[0].role === 'system');
check('the assistant name + style reach the prompt', /Realm AI/.test(JSON.parse(calls.filter((c) => c.url.includes('/api/chat')).pop().body).messages[0].content));
check('a "Try again" affordance is offered', /Try again/.test(document.getElementById('messages').textContent));

const second = await boot({ withLocalKey: true });
const doc2 = second.document;
await waitFor(() => /GEMINI_API_KEY/.test(doc2.getElementById('backendStatus')?.textContent || ''));
check('when the secret is missing, the strip names it', /GEMINI_API_KEY/.test(doc2.getElementById('backendStatus').textContent), doc2.getElementById('backendStatus').textContent);
doc2.getElementById('prompt').value = 'Use my saved test key';
second.window.sendMsg();
const directOk = await waitFor(() => /Direct-key reply from the model/.test(doc2.getElementById('messages').textContent));
const chatCalls = second.window ? calls.filter((c) => c.url.includes('generativelanguage')) : [];
check('with a locally saved key the browser falls back to it', directOk, doc2.getElementById('messages').textContent.slice(-160));
check('and never sends the key to our own origin', chatCalls.every((c) => !/AIza/.test(c.url)));
check('no stray "undefined" reply is stored', !/undefined/.test(doc2.getElementById('messages').textContent));

console.log('\nsanity: other interactive surfaces');
check('view switcher updates the breadcrumb', (() => { window.showView('image'); return document.getElementById('crumbName').textContent === 'Image Generator'; })());
check('contact sales opens a real form', (() => { window.contactSales(); return Boolean(document.getElementById('salesModal')); })());
check('legal modal renders text', (() => { window.showInfo('Privacy'); return (document.getElementById('infoB').textContent || '').length > 40; })());
check('login modal opens from the header button', (() => { document.getElementById('loginBtn').click(); return document.getElementById('loginModal').classList.contains('show'); })());
check('no Paddle call was attempted with a sandbox token', openedCheckouts.length === 0);

console.log('\nagent runner UI (plan → steps → verify, driven by /api/agent)');
{
  const a = await boot();
  const w = a.window, d = a.document;
  d.getElementById('agentTask').value = 'Make me a 5-day study plan for finals';
  d.getElementById('agentContext').value = 'I can study 2 hours a day.';
  agentCalls.length = 0; agentMode = 'ok';
  const callsStart = calls.length;
  w.runAgent();
  const finished = await waitFor(() => /Day 1: revise/.test(d.getElementById('agentResult').textContent));
  check('the run finishes and renders the verified result', finished, d.getElementById('agentStatus').textContent);
  check('every step is requested exactly once, in order', JSON.stringify(agentCalls) === '["plan","step","step","step","verify"]', JSON.stringify(agentCalls));
  const cards = [...d.querySelectorAll('#agentSteps .agent-step')];
  check('three step cards are rendered', cards.length === 3, String(cards.length));
  check('all steps end in the done state', cards.every((c) => /\bdone\b/.test(c.className)), cards.map((c) => c.className).join('|'));
  check('each step shows its own output under it', cards.every((c) => /Output for step/.test(c.textContent)));
  check('step titles from the plan are visible', /Collect constraints/.test(d.getElementById('agentSteps').textContent));
  check('status reports a verified run', /verified against the goal/i.test(d.getElementById('agentStatus').textContent), d.getElementById('agentStatus').textContent);
  check('copy button appears only with a result', d.getElementById('agentCopy').style.display === '');
  check('the run timer is cleared', d.getElementById('agentTimer').textContent === '');
  {
    const runCalls = calls.slice(callsStart);
    const planCall = runCalls.filter((c) => /\/api\/agent/.test(c.url) && JSON.parse(c.body).phase === 'plan').pop();
    const planBody = JSON.parse(planCall.body);
    check('the goal + extra context are sent to the planner', /5-day study plan/.test(planBody.goal) && /2 hours a day/.test(planBody.context), JSON.stringify(planBody));
    check('the agent view does not call /api/chat', !runCalls.some((c) => /\/api\/chat/.test(c.url)), JSON.stringify(runCalls.map((c) => c.url)));
  }
  check("markdown in the final answer is rendered as HTML (app's own md())", /<h4>Study plan<\/h4>/.test(d.getElementById('agentResult').innerHTML) && /<b>Verified against the goal\.<\/b>/.test(d.getElementById('agentResult').innerHTML), d.getElementById('agentResult').innerHTML.slice(0, 120));
  check('agent UI boots without page errors', a.problems.length === 0, a.problems.join(' | '));

  // a mid-run failure must leave the plan on screen and name the failing step
  const b = await boot();
  agentMode = 'slowstep';
  b.document.getElementById('agentTask').value = 'another goal';
  b.window.runAgent();
  const failed = await waitFor(() => /Step 2 failed/i.test(b.document.getElementById('agentStatus').textContent));
  check('a failed step is reported with its number', failed, b.document.getElementById('agentStatus').textContent);
  check('the failing step is marked, the finished one stays done', (() => {
    const cls = [...b.document.querySelectorAll('#agentSteps .agent-step')].map((c) => (c.className.match(/done|fail|run/) || ['wait'])[0]);
    return cls[0] === 'done' && cls[1] === 'fail';
  })(), [...b.document.querySelectorAll('#agentSteps .agent-step')].map((c) => c.className).join('|'));
  check('no verify call is made after a failure', !agentCalls.includes('verify') || agentCalls.lastIndexOf('verify') < agentCalls.lastIndexOf('step'), JSON.stringify(agentCalls));
  agentMode = 'ok';

  // stop button
  const c2 = await boot();
  agentMode = 'cancel';
  c2.document.getElementById('agentTask').value = 'long goal';
  const stopPromise = c2.window.runAgent();
  await waitFor(() => c2.document.querySelectorAll('#agentSteps .agent-step').length === 3);
  c2.window.stopAgent();
  await stopPromise;
  check('Stop halts the run after the current step', /Stopped after/i.test(c2.document.getElementById('agentStatus').textContent), c2.document.getElementById('agentStatus').textContent);
  check('stopping keeps partial results visible', /Output for step/.test(c2.document.getElementById('agentSteps').textContent));
  agentMode = 'ok';

  // backend not configured → actionable message, not a stack trace
  const e2 = await boot();
  agentMode = 'off';
  const originalFetch = e2.window.fetch;
  e2.window.fetch = async (u, o) => (String(u).includes('/api/agent') ? json({ error: 'AI is not connected yet.', code: 'AI_NOT_CONFIGURED' }, 503) : originalFetch(u, o));
  e2.document.getElementById('agentTask').value = 'goal';
  await e2.window.runAgent();
  check('without a backend the agent explains what to do', /not connected yet/i.test(e2.document.getElementById('agentStatus').textContent), e2.document.getElementById('agentStatus').textContent);
  check('and offers a direct link to Settings', /Open Settings/.test(e2.document.getElementById('agentResult').innerHTML), e2.document.getElementById('agentResult').innerHTML);
  agentMode = 'ok';
}

if (failures.length) {
  console.error(`\n${failures.length} UI check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
console.log(`\n${passed} UI check(s) passed.\n`);
