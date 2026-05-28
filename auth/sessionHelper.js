// sessionHelper.js

const crypto = require('crypto');
const secp = require('@noble/secp256k1');

// nonce -> { expiresAt: number, used: boolean, messageToSign: string }
const walletAuthNonces = new Map();

function generateNonce() {
  return crypto.randomBytes(32).toString('hex');
}

function pruneNonces() {
  const now = Date.now();
  for (const [nonce, entry] of walletAuthNonces.entries()) {
    if (!entry || entry.used || entry.expiresAt <= now) {
      walletAuthNonces.delete(nonce);
    }
  }
}

function buildWalletAuthMessage({ nonce, domain }) {
  // iOS must sign this EXACT string.
  return `SplitRewards Wallet Authentication
domain=${domain}
nonce=${nonce}`;
}

function issueNonce({ ttlMs = 5 * 60 * 1000, domain = 'example.invalid' } = {}) {
  pruneNonces();

  const nonce = generateNonce();
  const expiresAtMs = Date.now() + ttlMs;

  const messageToSign = buildWalletAuthMessage({ nonce, domain });

  walletAuthNonces.set(nonce, {
    expiresAt: expiresAtMs,
    used: false,
    messageToSign,
  });

  return {
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    messageToSign,
  };
}

function peekNonce(nonce) {
  pruneNonces();
  const entry = walletAuthNonces.get(nonce);
  if (!entry || entry.used || entry.expiresAt <= Date.now()) return null;

  return {
    messageToSign: entry.messageToSign,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

function consumeNonce(nonce) {
  pruneNonces();
  const entry = walletAuthNonces.get(nonce);
  if (!entry || entry.used || entry.expiresAt <= Date.now()) return false;

  entry.used = true;
  walletAuthNonces.set(nonce, entry);
  return true;
}

// --- Signature verification ---

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

// STRICT hex only (your server logs show this is what you receive)
function decodeSigHexStrict(signature) {
  if (typeof signature !== 'string') return null;

  let s = signature.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);

  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length % 2 !== 0) return null;

  return Buffer.from(s, 'hex');
}

function normalizePubkeyHex(pubkeyHex) {
  if (typeof pubkeyHex !== 'string') return null;

  let hex = pubkeyHex.trim();
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  hex = hex.toLowerCase();

  // accept compressed (33 bytes) or uncompressed (65 bytes)
  if (hex.length === 66 || hex.length === 130) return hex;

  // if uncompressed without 04 prefix (64 bytes), add it
  if (hex.length === 128) return `04${hex}`;

  return null;
}

/**
 * Breez Spark:
 * - message is SHA256 hashed before signing/verifying :contentReference[oaicite:1]{index=1}
 * - compact signature is 64-byte r||s hex when compact=true :contentReference[oaicite:2]{index=2}
 */
function verifyBreezSignedMessage({ message, pubkey, signature }) {
  const pubkeyHex = normalizePubkeyHex(pubkey);
  if (!pubkeyHex) return false;
  if (typeof message !== 'string' || message.length < 1) return false;

  const sigBuf = decodeSigHexStrict(signature);
  if (!sigBuf) return false;

  const msgBytes = Buffer.from(message, 'utf8');
  const msgHash = sha256(msgBytes); // Breez behavior: one SHA256

  // Convert pubkey hex -> bytes for noble (your version requires Uint8Array)
  const pubkeyBytes = Buffer.from(pubkeyHex, 'hex');

  try {
    // Compact signature (64 bytes), which your client is sending
    if (sigBuf.length === 64) {
      return secp.verify(
        sigBuf,          // Uint8Array
        msgHash,         // Uint8Array (hash)
        pubkeyBytes,     // Uint8Array (pubkey)
        { format: 'compact', prehash: false, lowS: false }
      );
    }

    // DER support (if you ever change iOS to compact:false)
    if (sigBuf[0] === 0x30) {
      return secp.verify(
        sigBuf,
        msgHash,
        pubkeyBytes,
        { format: 'der', prehash: false, lowS: false }
      );
    }

    // 65-byte edge cases (strip recovery byte)
    if (sigBuf.length === 65) {
      const a = sigBuf.slice(0, 64);
      const b = sigBuf.slice(1);
      return (
        secp.verify(a, msgHash, pubkeyBytes, { format: 'compact', prehash: false, lowS: false }) ||
        secp.verify(b, msgHash, pubkeyBytes, { format: 'compact', prehash: false, lowS: false })
      );
    }

    return false;
  } catch (e) {
    console.error('verifyBreezSignedMessage error:', e);
    return false;
  }
}

module.exports = {
  issueNonce,
  peekNonce,
  consumeNonce,
  pruneNonces,
  verifyBreezSignedMessage,
};
