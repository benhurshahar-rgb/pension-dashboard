// Encryption helpers.
//
// Two layers:
// 1. "Sealed" files (data/state.sealed.json, data/inbox/*.json) are encrypted to an
//    X25519 public key (keys/public.json). Anyone can seal new data with the public key;
//    only the GitHub Action (which derives the private key from DASHBOARD_PASSWORD) can open it.
// 2. The published page payload (_site/data.enc.json) is AES-GCM encrypted with a key
//    derived from DASHBOARD_PASSWORD via PBKDF2, so the browser can open it with the password.
import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
export const PAGE_KDF_ITERATIONS = 600000;

export function deriveKeyPair(password) {
  const seed = crypto.pbkdf2Sync(password, 'pension-dashboard/x25519/v1', PAGE_KDF_ITERATIONS, 32, 'sha256');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, publicRaw: publicKeyToRaw(publicKey) };
}

export function publicKeyToRaw(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return b64(der.subarray(der.length - 32));
}

export function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, unb64(raw)]), format: 'der', type: 'spki' });
}

function sealKey(shared, epkRaw) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, unb64(epkRaw), 'pension-dashboard/seal/v1', 32));
}

export function seal(obj, publicRaw) {
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = publicKeyToRaw(eph.publicKey);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(publicRaw) });
  const key = sealKey(shared, epk);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'x25519-hkdf-aes256gcm', to: publicRaw, epk, iv: b64(iv), ct: b64(ct) };
}

export function open(sealed, privateKey) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicKeyFromRaw(sealed.epk) });
  const key = sealKey(shared, sealed.epk);
  const raw = unb64(sealed.ct);
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(sealed.iv));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const pt = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export function encryptForPage(obj, password, saltB64) {
  const salt = unb64(saltB64);
  const key = crypto.pbkdf2Sync(password, salt, PAGE_KDF_ITERATIONS, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PAGE_KDF_ITERATIONS, salt: saltB64, iv: b64(iv), ct: b64(ct) };
}

export const newSalt = () => b64(crypto.randomBytes(16));
export { b64url };
