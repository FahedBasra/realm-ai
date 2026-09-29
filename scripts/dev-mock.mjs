#!/usr/bin/env node
/**
 * Start the offline mock provider and the Worker together: `npm run dev:mock` gives you a fully
 * clickable Realm AI with no API key and no quota spend (chat + agent answers come from the mock).
 *
 * Development convenience only. Nothing here is deployed, and .dev.vars is never committed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MOCK_PORT || 9123);
const devVars = path.join(root, '.dev.vars');
const backupPath = `${devVars}.bak`;

// Point the Worker at the mock for this session; restore afterwards.
if (existsSync(devVars) && !existsSync(backupPath)) writeFileSync(backupPath, readFileSync(devVars, 'utf8'));
writeFileSync(
  devVars,
  '# written by npm run dev:mock — local only, gitignored. Restore: rm .dev.vars && kill the dev:mock process\n' +
  'GEMINI_API_KEY=mock-key-not-a-real-secret\n' +
  `GEMINI_BASE_URL=http://127.0.0.1:${PORT}\nPROVIDER_TIMEOUT_MS=8000\nRATE_LIMIT_PER_MINUTE=0\n` +
  // Billing is mocked by the same process, so the money paths can be exercised offline too.
  // (A real Checkout still needs live price ids in public/tiers.js — everything behind it is testable.)
  'PADDLE_ENV=sandbox\nPADDLE_CLIENT_TOKEN=test_mock_token\nPADDLE_API_KEY=pdl_sdbxMOCKKEY\n' +
  `PADDLE_API_BASE=http://127.0.0.1:${PORT}\nPADDLE_WEBHOOK_SECRET=trl_local\n` +
  `SUPABASE_URL=http://127.0.0.1:${PORT}\nSUPABASE_SERVICE_ROLE_KEY=mock_service_role\n`
);

const mock = spawn(process.execPath, [path.join(root, 'scripts/mock-gemini.mjs'), String(PORT)], { stdio: 'inherit' });
const worker = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev'], { cwd: root, stdio: 'inherit' });

let done = false;
const stop = () => {
  if (done) return;
  done = true;
  mock.kill('SIGTERM');
  worker.kill('SIGTERM');
  if (existsSync(backupPath)) {
    writeFileSync(devVars, readFileSync(backupPath, 'utf8'));
    rmSync(backupPath, { force: true });
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
mock.on('exit', stop);
worker.on('exit', stop);

console.log(`\n  mock provider : http://127.0.0.1:${PORT}\n  Realm AI dev  : http://localhost:8787  (chat + agent answer from the mock)\n  Ctrl+C stops both and restores .dev.vars\n`);
console.log('  payment paths, offline:');
console.log('    curl "http://127.0.0.1:8787/api/checkout-status?txn=' + 'txn_' + 'a'.repeat(26) + '"');
console.log('    npm run mock:webhook      # signed transaction.paid → see activation actions\n');
