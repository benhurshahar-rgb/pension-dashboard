// Daily job (GitHub Action). Needs the DASHBOARD_PASSWORD secret.
//  1. derive keys from the password, publish _site/public.json
//  2. open data/state.sealed.json (read-only – this job never writes to the repo)
//  3. fetch market data, compute the payload
//  4. write _site/ (page + password-encrypted payload)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveKeyPair, open, encryptForPage } from './crypto.mjs';
import { updateMarket } from './market.mjs';
import { computePayload } from './compute.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const P = (...x) => path.join(ROOT, ...x);
const OFFLINE = process.env.OFFLINE_MARKET; // tests: path to a JSON market cache

const password = process.env.DASHBOARD_PASSWORD;
if (!password) {
  console.error('::error::Missing secret DASHBOARD_PASSWORD. Add it in Settings → Secrets and variables → Actions.');
  process.exit(1);
}

const keys = deriveKeyPair(password);
const pubJson = JSON.stringify({ alg: 'x25519', public: keys.publicRaw }, null, 2) + '\n';
console.log('Public key: ' + keys.publicRaw);

const stateFile = P('data', 'state.sealed.json');
let state = null;
if (fs.existsSync(stateFile)) {
  try {
    state = open(JSON.parse(fs.readFileSync(stateFile, 'utf8')), keys.privateKey);
  } catch {
    console.error('::error::Cannot open data/state.sealed.json – was DASHBOARD_PASSWORD changed? Re-seal the state with the new key.');
    process.exit(1);
  }
}

const pageSalt = crypto.createHash('sha256').update('pension-dashboard/page-salt/v1:' + password).digest().subarray(0, 16).toString('base64');
const pageKey = crypto.pbkdf2Sync(password, Buffer.from(pageSalt, 'base64'), 600000, 32, 'sha256');

// ---- balance updates made from the site ("עדכן יתרה"): data/updates/*.json, AES-GCM with the page key.
// Applied in memory on every run (the job never writes to the repo); an update only wins if it is
// at least as recent as the balance already in the state.
const updDir = P('data', 'updates');
if (state && fs.existsSync(updDir)) {
  const files = fs.readdirSync(updDir).filter((f) => f.endsWith('.json')).sort();
  for (const name of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(updDir, name), 'utf8'));
      const raw = Buffer.from(e.ct, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', pageKey, Buffer.from(e.iv, 'base64'));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const u = JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
      const f = state.people.flatMap((p) => p.funds).find((x) => x.id === u.fundId);
      if (!f) { console.log(`::warning::${name}: unknown fund`); continue; }
      if (!f.balanceDate || u.balanceDate >= f.balanceDate) {
        Object.assign(f, { balance: u.balance, balanceDate: u.balanceDate, ...(u.units ? { units: u.units } : {}) });
        console.log(`Applied update ${name}`);
      }
    } catch {
      console.log(`::warning::${name}: cannot decrypt (old password?)`);
    }
  }
}

fs.mkdirSync(P('_site'), { recursive: true });
fs.copyFileSync(P('site', 'index.html'), P('_site', 'index.html'));
fs.writeFileSync(P('_site', 'public.json'), pubJson);

if (!state) {
  console.log('No state yet – published public.json only. Seal the state to it and commit data/state.sealed.json.');
  fs.writeFileSync(P('_site', 'data.enc.json'), JSON.stringify({ empty: true }));
  process.exit(0);
}

// ---- market + payload ----------------------------------------------------
const market = OFFLINE ? JSON.parse(fs.readFileSync(OFFLINE, 'utf8')) : await updateMarket();
console.log((market.log || []).join('\n'));
const today = process.env.TODAY || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
const payload = computePayload(state, market, today);
fs.writeFileSync(P('_site', 'data.enc.json'), JSON.stringify(encryptForPage(payload, password, pageSalt)));
console.log(`Built page: total ₪${Math.round(payload.family.total).toLocaleString('en-US')} (${today})`);
