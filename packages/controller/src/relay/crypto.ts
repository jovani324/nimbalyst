/**
 * E2E crypto for the personal sync lane.
 *
 * Deliberately mirrors Nimbalyst's own derivation so ciphertext written by the
 * host decrypts here byte-for-byte:
 *   key = PBKDF2(seed, salt = "nimbalyst:" + personalUserId, 100k, SHA-256)
 *       -> AES-GCM 256
 * (see SyncManager.deriveEncryptionKey and CollabV3Sync's encrypt/decrypt).
 *
 * Uses only Web Crypto and btoa/atob -- no Node builtins -- so this same file
 * runs in a browser, in Node >= 22, and in a Tauri webview without a shim.
 * Verified against the live relay before this package existed.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

// The explicit `ArrayBuffer` arg matters: bare `Uint8Array` widens to
// `ArrayBufferLike`, which includes SharedArrayBuffer and so is not a
// `BufferSource` the Web Crypto signatures accept.
function b64ToU8(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/**
 * Web Crypto is exposed only in a secure context, so serving this app over
 * plain `http://<lan-or-tailnet-ip>` leaves `crypto.subtle` undefined and every
 * call below dies on "Cannot read properties of undefined". Callers check this
 * first and say so, rather than surfacing that as a pairing failure.
 */
export function isCryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle !== 'undefined';
}

export const INSECURE_CONTEXT_MESSAGE =
  'This page needs a secure context for encryption, and is being served over plain http. ' +
  'Open it on localhost, or over https (Tailscale Serve gives you an https URL for the same server).';

/** The salt is the personal user id -- a team member id here decrypts nothing. */
export async function deriveEncryptionKey(seed: string, personalUserId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(seed), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(`nimbalyst:${personalUserId}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(
  content: string,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(content));
  return { encrypted: u8ToB64(new Uint8Array(ct)), iv: u8ToB64(iv) };
}

export async function decrypt(encrypted: string, iv: string, key: CryptoKey): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToU8(iv) },
    key,
    b64ToU8(encrypted)
  );
  return dec.decode(pt);
}
