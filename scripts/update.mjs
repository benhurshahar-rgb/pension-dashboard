// Daily job (GitHub Action). Needs the DASHBOARD_PASSWORD secret.
//  1. derive keys from the password, publish keys/public.json
//  2. open data/state.sealed.json, apply sealed patches from data/inbox/
//  3. refresh market data, compute the payload, append a history point
//  4. re-seal the state, write _site/ (page + password-encrypted payload)
import fs from 'node:fs';
import path from 'node:path';
import { deriveKeyPair, open, seal, encryptForPage, newSalt } from './crypto.mjs';
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
fs.mkdirSync(P('keys'), { recursive: true });
const pubFile = P('keys', 'public.json');
const pubJson = JSON.stringify({ alg: 'x25519', public: keys.publicRaw }, null, 2) + '\n';
if (!fs.existsSync(pubFile) || fs.readFileSync(pubFile, 'utf8') !== pubJson) {
  fs.writeFileSync(pubFile, pubJson);
  console.log('Wrote keys/public.json');
}

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

// ---- apply inbox patches -------------------------------------------------
const inbox = P('data', 'inbox');
const patches = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).sort() : [];
for (const name of patches) {
  const file = path.join(inbox, name);
  let patch;
  try {
    patch = open(JSON.parse(fs.readFileSync(file, 'utf8')), keys.privateKey);
  } catch {
    console.error(`::warning::Skipping ${name}: cannot decrypt (sealed to a different key?)`);
    continue;
  }
  if (patch.op === 'replace') {
    const keep = state ? { history: state.history, market: state.market, pageSalt: state.pageSalt } : {};
    state = { ...patch.state, ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v != null)) };
  } else if (patch.op === 'funds' && state) {
    for (const u of patch.updates) {
      for (const p of state.people) {
        const f = p.funds.find((x) => x.id === u.id);
        if (f) Object.assign(f, u);
      }
      if (u.addTo) {
        const p = state.people.find((x) => x.id === u.addTo);
        if (p && !p.funds.find((x) => x.id === u.id)) { const { addTo, ...rest } = u; p.funds.push(rest); }
      }
    }
  } else if (patch.op === 'insurance' && state) {
    state.insurance = patch.items;
  } else {
    console.error(`::warning::Unknown patch ${name}`);
    continue;
  }
  fs.unlinkSync(file);
  console.log(`Applied ${name}`);
}

fs.mkdirSync(P('_site'), { recursive: true });
fs.copyFileSync(P('site', 'index.html'), P('_site', 'index.html'));

if (!state) {
  console.log('No state yet – published keys only. Seal data to keys/public.json and push it to data/inbox/.');
  fs.writeFileSync(P('_site', 'data.enc.json'), JSON.stringify({ empty: true }));
  process.exit(0);
}

// ---- market + payload ----------------------------------------------------
state.market = OFFLINE ? JSON.parse(fs.readFileSync(OFFLINE, 'utf8')) : await updateMarket(state.market);
console.log((state.market.log || []).join('\n'));
const today = process.env.TODAY || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
const payload = computePayload(state, state.market, today);

state.history = (state.history || []).filter((h) => h.date !== today);
state.history.push({ date: today, total: Math.round(payload.family.total), ...Object.fromEntries(payload.people.map((p) => [p.id, Math.round(p.total)])) });
payload.history = state.history.slice(-400);

state.pageSalt ||= newSalt();
fs.writeFileSync(stateFile, JSON.stringify(seal(state, keys.publicRaw)) + '\n');
fs.writeFileSync(P('_site', 'data.enc.json'), JSON.stringify(encryptForPage(payload, password, state.pageSalt)));
console.log(`Built page: total ₪${Math.round(payload.family.total).toLocaleString('en-US')} (${today})`);
