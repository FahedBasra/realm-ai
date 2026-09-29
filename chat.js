// Cloudflare Pages Function: /api/chat (Gemini). The API key stays on the server, never in the browser.
// Cloudflare > Settings > Variables and Secrets: GEMINI_API_KEY (secret), GEMINI_MODEL (optional)
export async function onRequestPost({ request, env }) {
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  if (!env.GEMINI_API_KEY) return json({ error: 'AI not configured' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  let contents = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-12)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.content || '').slice(0, 4000) }] }))
    .filter(m => m.parts[0].text);
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length) return json({ error: 'Empty' }, 400);

  const model = env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are Realm AI, a helpful, friendly assistant. Reply in English unless the user writes in another language. Be clear and concise.' }] },
      contents,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) return json({ error: 'Too many requests right now. Please try again in a moment.' }, 429);
  if (!r.ok) return json({ error: d?.error?.message || 'AI error' }, 502);
  const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return json({ text: text || 'I could not generate a reply. Please try again.' });
}
