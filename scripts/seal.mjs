// Seal a plaintext JSON patch to the Action's public key, so it can be committed safely.
//   node scripts/seal.mjs patch.json data/inbox/2026-11-10-mislaka.json
// Patch shapes:
//   { "op": "replace", "state": { ...full state... } }
//   { "op": "funds", "updates": [ { "id": "s-migdal-pension", "balance": 500000, "balanceDate": "2026-11-01" } ] }
//   { "op": "insurance", "items": [ ... ] }
// Never commit the plaintext file.
import fs from 'node:fs';
import { seal } from './crypto.mjs';

const [, , src, dest] = process.argv;
if (!src || !dest) { console.error('usage: node scripts/seal.mjs <plain.json> <out.json>'); process.exit(1); }
const pub = JSON.parse(fs.readFileSync(new URL('../keys/public.json', import.meta.url), 'utf8')).public;
fs.writeFileSync(dest, JSON.stringify(seal(JSON.parse(fs.readFileSync(src, 'utf8')), pub)) + '\n');
console.log(`sealed → ${dest}`);
