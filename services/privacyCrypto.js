const crypto = require('crypto');

const USER_HMAC_VERSION = 'split-user-hmac-sha256-v1';
const MESSAGING_HMAC_VERSION = 'split-messaging-hmac-sha256-v1';
const PUSH_TOKEN_KEY_VERSION = 'split-push-token-aes-gcm-v1';
const PAYOUT_DESTINATION_KEY_VERSION = 'split-payout-destination-aes-gcm-v1';
const MESSAGING_BINDING_KEY_VERSION = 'split-messaging-binding-aes-gcm-v1';
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

function normalizeInteger(value) {
  if (Number.isInteger(value)) return value;

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }

  return null;
}

function bindingSignedAtSeconds(value) {
  const parsedInteger = normalizeInteger(value);
  if (parsedInteger != null) return parsedInteger;

  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  const parsedDate = Date.parse(String(value || ''));
  return Number.isNaN(parsedDate) ? null : Math.floor(parsedDate / 1000);
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

function decodeAes256Key(rawKey, { secretName = 'PUSH_TOKEN_ENCRYPTION_KEY' } = {}) {
  const value = getRequiredSecret(secretName, rawKey);
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

  throw new Error(`${secretName} must decode to 32 bytes`);
}

function encryptAesGcmString(value, {
  key = null,
  keyVersion,
  secretName,
  fieldPrefix,
} = {}) {
  const plaintext = trimString(value);
  if (!plaintext) {
    throw new Error(`${fieldPrefix} is required`);
  }

  const encryptionKey = decodeAes256Key(key, { secretName });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    [`${fieldPrefix}Ciphertext`]: ciphertext.toString('base64'),
    [`${fieldPrefix}Iv`]: iv.toString('base64'),
    [`${fieldPrefix}AuthTag`]: authTag.toString('base64'),
    [`${fieldPrefix}KeyVersion`]: keyVersion,
  };
}

function decryptAesGcmString({
  ciphertext,
  iv,
  authTag,
  key = null,
  secretName,
}) {
  const encryptionKey = decodeAes256Key(key, { secretName });
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptPushToken(deviceToken, {
  key = null,
  keyVersion = PUSH_TOKEN_KEY_VERSION,
} = {}) {
  return encryptAesGcmString(deviceToken, {
    key,
    keyVersion,
    secretName: 'PUSH_TOKEN_ENCRYPTION_KEY',
    fieldPrefix: 'deviceToken',
  });
}

function decryptPushToken({
  deviceTokenCiphertext,
  deviceTokenIv,
  deviceTokenAuthTag,
  key = null,
}) {
  return decryptAesGcmString({
    ciphertext: deviceTokenCiphertext,
    iv: deviceTokenIv,
    authTag: deviceTokenAuthTag,
    key,
    secretName: 'PUSH_TOKEN_ENCRYPTION_KEY',
  });
}

function encryptSparkAddress(sparkAddress, {
  key = null,
  keyVersion = PAYOUT_DESTINATION_KEY_VERSION,
} = {}) {
  const normalizedSparkAddress = normalizeSparkAddress(sparkAddress);
  return encryptAesGcmString(normalizedSparkAddress, {
    key,
    keyVersion,
    secretName: 'PAYOUT_DESTINATION_ENCRYPTION_KEY',
    fieldPrefix: 'sparkAddress',
  });
}

function decryptSparkAddress({
  sparkAddressCiphertext,
  sparkAddressIv,
  sparkAddressAuthTag,
  key = null,
}) {
  return decryptAesGcmString({
    ciphertext: sparkAddressCiphertext,
    iv: sparkAddressIv,
    authTag: sparkAddressAuthTag,
    key,
    secretName: 'PAYOUT_DESTINATION_ENCRYPTION_KEY',
  });
}

function normalizeMessagingBindingPayload(binding = {}) {
  const walletPubkey = normalizeWalletPubkey(binding.walletPubkey);
  const lightningAddressHash = normalizeClientHash(binding.lightningAddressHash);
  const lightningAddressHashScheme = trimString(binding.lightningAddressHashScheme);
  const messagingPubkey = normalizeMessagingPubkey(binding.messagingPubkey);
  const messagingIdentitySignature = trimString(binding.messagingIdentitySignature);
  const messagingIdentitySignatureVersion = normalizeInteger(binding.messagingIdentitySignatureVersion);
  const messagingIdentitySignedAt = bindingSignedAtSeconds(binding.messagingIdentitySignedAt);

  if (!walletPubkey) throw new Error('binding.walletPubkey is required or invalid');
  if (!lightningAddressHash) throw new Error('binding.lightningAddressHash is required or invalid');
  if (!lightningAddressHashScheme) throw new Error('binding.lightningAddressHashScheme is required');
  if (!messagingPubkey) throw new Error('binding.messagingPubkey is required or invalid');
  if (!messagingIdentitySignature) throw new Error('binding.messagingIdentitySignature is required');
  if (!Number.isInteger(messagingIdentitySignatureVersion)) {
    throw new Error('binding.messagingIdentitySignatureVersion is required');
  }
  if (!Number.isInteger(messagingIdentitySignedAt) || messagingIdentitySignedAt <= 0) {
    throw new Error('binding.messagingIdentitySignedAt is required or invalid');
  }

  return {
    walletPubkey,
    lightningAddressHash,
    lightningAddressHashScheme,
    messagingPubkey,
    messagingIdentitySignature,
    messagingIdentitySignatureVersion,
    messagingIdentitySignedAt,
  };
}

function encryptMessagingBindingPayload(binding, {
  key = null,
  keyVersion = MESSAGING_BINDING_KEY_VERSION,
} = {}) {
  const normalizedBinding = normalizeMessagingBindingPayload(binding);
  return encryptAesGcmString(JSON.stringify(normalizedBinding), {
    key,
    keyVersion,
    secretName: 'MESSAGING_BINDING_ENCRYPTION_KEY',
    fieldPrefix: 'bindingPayload',
  });
}

function decryptMessagingBindingPayload({
  bindingPayloadCiphertext,
  bindingPayloadIv,
  bindingPayloadAuthTag,
  key = null,
}) {
  const plaintext = decryptAesGcmString({
    ciphertext: bindingPayloadCiphertext,
    iv: bindingPayloadIv,
    authTag: bindingPayloadAuthTag,
    key,
    secretName: 'MESSAGING_BINDING_ENCRYPTION_KEY',
  });

  let parsed = null;
  try {
    parsed = JSON.parse(plaintext);
  } catch (_error) {
    throw new Error('Encrypted messaging binding payload is invalid JSON');
  }

  return normalizeMessagingBindingPayload(parsed);
}

module.exports = {
  LIGHTNING_ADDRESS_CLIENT_HASH_PREFIX,
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  MESSAGING_BINDING_KEY_VERSION,
  MESSAGING_HMAC_VERSION,
  PAYOUT_DESTINATION_KEY_VERSION,
  PUSH_TOKEN_KEY_VERSION,
  USER_HMAC_VERSION,
  clientHashLightningAddress,
  decryptMessagingBindingPayload,
  decryptSparkAddress,
  decryptPushToken,
  encryptMessagingBindingPayload,
  encryptSparkAddress,
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
