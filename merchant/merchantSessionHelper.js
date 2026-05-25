const crypto = require('crypto');

const walletSessionHelper = require('../auth/sessionHelper');

const merchantAuthNonces = new Map();

function generateNonce() {
  return crypto.randomBytes(32).toString('hex');
}

function pruneNonces() {
  const now = Date.now();
  for (const [nonce, entry] of merchantAuthNonces.entries()) {
    if (!entry || entry.used || entry.expiresAt <= now) {
      merchantAuthNonces.delete(nonce);
    }
  }
}

function buildMerchantAuthMessage({ nonce, domain }) {
  return `Split Merchant Wallet Authentication
domain=${domain}
nonce=${nonce}`;
}

function issueNonce({ ttlMs = 5 * 60 * 1000, domain = 'merchant.splitrewards.app' } = {}) {
  pruneNonces();

  const nonce = generateNonce();
  const expiresAtMs = Date.now() + ttlMs;
  const messageToSign = buildMerchantAuthMessage({ nonce, domain });

  merchantAuthNonces.set(nonce, {
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
  const entry = merchantAuthNonces.get(nonce);
  if (!entry || entry.used || entry.expiresAt <= Date.now()) return null;

  return {
    messageToSign: entry.messageToSign,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

function consumeNonce(nonce) {
  pruneNonces();
  const entry = merchantAuthNonces.get(nonce);
  if (!entry || entry.used || entry.expiresAt <= Date.now()) return false;

  entry.used = true;
  merchantAuthNonces.set(nonce, entry);
  return true;
}

module.exports = {
  issueNonce,
  peekNonce,
  consumeNonce,
  pruneNonces,
  verifyBreezSignedMessage: walletSessionHelper.verifyBreezSignedMessage,
};
