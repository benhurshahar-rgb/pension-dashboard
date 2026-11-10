// Seal a plaintext JSON patch to the Action's public key, so it can be committed safely.
//   node scripts/seal.mjs state.plain.json data/state.sealed.json
// The public key is published by the Action at <site>/public.json and kept in keys/public.json.
// Never commit the plaintext file.
import fs from 'node:fs';
import { seal } from './crypto.mjs';

const [, , src, dest] = process.argv;
if (!src || !dest) { console.error('usage: node scripts/seal.mjs <plain.json> <out.json>'); process.exit(1); }
const pub = JSON.parse(fs.readFileSync(new URL('../keys/public.json', import.meta.url), 'utf8')).public;
fs.writeFileSync(dest, JSON.stringify(seal((j => j.op === 'replace' ? j.state : j)(JSON.parse(fs.readFileSync(src, 'utf8'))), pub)) + '\n');
console.log(`sealed → ${dest}`);
