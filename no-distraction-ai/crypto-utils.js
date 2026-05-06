// No Distraction AI – Crypto Utilities
// AES-GCM encryption with PBKDF2 key derivation from PIN
// PIN is NEVER stored — only used transiently to derive encryption key

const NdaCrypto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function deriveKey(pin, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encrypt(plaintext, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await deriveKey(pin, salt);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
    );
    return {
      salt: Array.from(salt),
      iv:   Array.from(iv),
      ct:   Array.from(new Uint8Array(cipherBuf))
    };
  }

  // Returns decrypted string, or throws if PIN is wrong
  async function decrypt(stored, pin) {
    const salt = new Uint8Array(stored.salt);
    const iv   = new Uint8Array(stored.iv);
    const ct   = new Uint8Array(stored.ct);
    const key  = await deriveKey(pin, salt);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(plainBuf);
  }

  return { encrypt, decrypt };
})();
