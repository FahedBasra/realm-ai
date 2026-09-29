/**
 * Netlify has moved environment access around between runtime versions (context.env, the
 * Netlify.env helper, process.env), and a function that silently reads {} turns into
 * "AI is not connected" with no clue why. So read all three.
 *
 * Lives outside netlify/functions/api.mjs on purpose: Netlify inspects the exports of a function
 * file to find its handler, so that file should only have the default export.
 */
import { ENV_KEYS } from './api.js';

export function collectEnv(context = {}, fallback = {}) {
  const env = { ...fallback };
  try {
    Object.assign(env, globalThis.process?.env || {});
  } catch {}
  try {
    if (context.env) Object.assign(env, context.env);
  } catch {}
  try {
    const netlify = context.netlify;
    if (netlify?.env?.get) {
      for (const key of ENV_KEYS) {
        const value = netlify.env.get(key);
        if (value !== undefined && value !== null) env[key] = value;
      }
    }
  } catch {}
  return env;
}
