const crypto = require('crypto');

const ALGORITHM = 'p256-hkdf-sha256-aes-256-gcm-v1';
const SALT = Buffer.from('split-reward-claim-v1', 'utf8');
const INFO = Buffer.from('reward-spend-claim-payload', 'utf8');

const privateKeyBase64 = process.env.REWARD_CLAIM_ECDH_PRIVATE_KEY_BASE64;
const key = crypto.createECDH('prime256v1');

if (privateKeyBase64) {
  key.setPrivateKey(Buffer.from(privateKeyBase64, 'base64'));
} else {
  key.generateKeys();
  if (process.env.NODE_ENV === 'production') {
    console.warn('REWARD_CLAIM_ECDH_PRIVATE_KEY_BASE64 is missing; using ephemeral reward claim key');
  }
}

const publicKey = key.getPublicKey();
const keyId = process.env.REWARD_CLAIM_KEY_ID || `reward-claims-${hashHex(publicKey).slice(0, 16)}`;

function publicKeyResponse() {
  return {
    ok: true,
    keyId,
    algorithm: ALGORITHM,
    publicKey: publicKey.toString('base64'),
  };
}

function decryptClaimEnvelope(envelope) {
  if (!envelope || envelope.keyId !== keyId || envelope.algorithm !== ALGORITHM) {
    throw new Error('Unsupported reward claim encryption key');
  }

  const ephemeralPublicKey = Buffer.from(String(envelope.ephemeralPublicKey || ''), 'base64');
  const nonce = Buffer.from(String(envelope.nonce || ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');

  if (ephemeralPublicKey.length !== 65 || nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Invalid encrypted reward claim payload');
  }

  const sharedSecret = key.computeSecret(ephemeralPublicKey);
  const aesKey = crypto.hkdfSync('sha256', sharedSecret, SALT, INFO, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  ALGORITHM,
  decryptClaimEnvelope,
  publicKeyResponse,
};
