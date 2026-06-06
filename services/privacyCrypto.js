const crypto = require('crypto');

const USER_HMAC_VERSION = 'split-user-hmac-sha256-v1';
const MESSAGING_HMAC_VERSION = 'split-messaging-hmac-sha256-v1';
const PUSH_TOKEN_KEY_VERSION = 'split-push-token-aes-gcm-v1';
const LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME = 'split-ln-address-sha256-v1';
const LIGHTNING_ADDRESS_CLIENT_HASH_PREFIX = 'split:messaging-ln:v1:';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripHexPrefix(value) {
  const trimmed = trimString(value);
  return trimmed.startsWith('0x') || trimmed.startsWith('0X')
    ? trimmed.slice(2)
    : trimmed;
}

function normalizeWalletPubkey(value) {
  let hex = stripHexPrefix(value);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  hex = hex.toLowerCase();
  if (hex.length === 66 || hex.length === 130) return hex;
  if (hex.length === 128) return `04${hex}`;

  return null;
}

function normalizeMessagingPubkey(value) {
  const hex = stripHexPrefix(value).toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/.test(hex) || /^[0-9a-f]{64}$/.test(hex)) {
    return hex;
  }

  return null;
}

function normalizeLightningAddress(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized || null;
}

function normalizeSparkAddress(value) {
  const normalized = trimString(value);
  return normalized || null;
}

function normalizeClientHash(value) {
  const normalized = stripHexPrefix(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function normalizePushDeviceToken({ deviceToken, platform }) {
  const trimmed = trimString(deviceToken);
  if (!trimmed) return null;

  return platform === 'apns'
    ? trimmed.toLowerCase()
    : trimmed;
}

function getRequiredSecret(name, providedValue) {
  const value = providedValue || process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function hmacSha256Hex(secret, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('HMAC value is required');
  }

  return crypto
    .createHmac('sha256', secret)
    .update(value, 'utf8')
    .digest('hex');
}

function userDataHmac(value, { pepper = null } = {}) {
  return hmacSha256Hex(getRequiredSecret('USER_DATA_PEPPER', pepper), value);
}

function messagingDataHmac(value, { pepper = null } = {}) {
  return hmacSha256Hex(getRequiredSecret('MESSAGING_DATA_PEPPER', pepper), value);
}

function pushTokenLookupHmac(value, { pepper = null } = {}) {
  return hmacSha256Hex(getRequiredSecret('PUSH_TOKEN_LOOKUP_PEPPER', pepper), value);
}

function clientHashLightningAddress(lightningAddress) {
  const normalized = normalizeLightningAddress(lightningAddress);
  if (!normalized) {
    throw new Error('Lightning address is required');
  }

  return crypto
    .createHash('sha256')
    .update(`${LIGHTNING_ADDRESS_CLIENT_HASH_PREFIX}${normalized}`, 'utf8')
    .digest('hex');
}

function decodeAes256Key(rawKey) {
  const value = getRequiredSecret('PUSH_TOKEN_ENCRYPTION_KEY', rawKey);
  const trimmed = trimString(value);

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  try {
    const base64Decoded = Buffer.from(trimmed, 'base64');
    if (base64Decoded.length === 32 && base64Decoded.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) {
      return base64Decoded;
    }
  } catch (_error) {
    // Fall through to utf8 validation.
  }

  const utf8Key = Buffer.from(trimmed, 'utf8');
  if (utf8Key.length === 32) {
    return utf8Key;
  }

  throw new Error('PUSH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
}

function encryptPushToken(deviceToken, {
  key = null,
  keyVersion = PUSH_TOKEN_KEY_VERSION,
} = {}) {
  const token = trimString(deviceToken);
  if (!token) {
    throw new Error('deviceToken is required');
  }

  const encryptionKey = decodeAes256Key(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    deviceTokenCiphertext: ciphertext.toString('base64'),
    deviceTokenIv: iv.toString('base64'),
    deviceTokenAuthTag: authTag.toString('base64'),
    deviceTokenKeyVersion: keyVersion,
  };
}

function decryptPushToken({
  deviceTokenCiphertext,
  deviceTokenIv,
  deviceTokenAuthTag,
  key = null,
}) {
  const encryptionKey = decodeAes256Key(key);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(deviceTokenIv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(deviceTokenAuthTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(deviceTokenCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = {
  LIGHTNING_ADDRESS_CLIENT_HASH_PREFIX,
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  MESSAGING_HMAC_VERSION,
  PUSH_TOKEN_KEY_VERSION,
  USER_HMAC_VERSION,
  clientHashLightningAddress,
  decryptPushToken,
  encryptPushToken,
  messagingDataHmac,
  normalizeClientHash,
  normalizeLightningAddress,
  normalizeMessagingPubkey,
  normalizePushDeviceToken,
  normalizeSparkAddress,
  normalizeWalletPubkey,
  pushTokenLookupHmac,
  userDataHmac,
};
