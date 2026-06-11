const {
  decryptMessagingBindingPayload,
  encryptMessagingBindingPayload,
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  MESSAGING_BINDING_KEY_VERSION,
  MESSAGING_HMAC_VERSION,
  messagingDataHmac,
  normalizeClientHash,
  normalizeMessagingPubkey,
  normalizeWalletPubkey,
} = require('./privacyCrypto');

const MESSAGING_IDENTITY_V4_SIGNATURE_VERSION = 4;
const MESSAGING_IDENTITY_V4_DOMAIN = process.env.MESSAGING_V4_IDENTITY_DOMAIN ||
  'example.messaging';

function parseIntegerValue(value) {
  if (Number.isInteger(value)) return value;

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }

  return null;
}

function normalizeSignature(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildMessagingIdentityV4Message({
  walletPubkey,
  lightningAddressHash,
  lightningAddressHashScheme = LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  messagingPubkey,
  signedAt,
  version = MESSAGING_IDENTITY_V4_SIGNATURE_VERSION,
  domain = MESSAGING_IDENTITY_V4_DOMAIN,
}) {
  return `SplitRewards Messaging Identity Authorization
version=${version}
domain=${domain}
hashScheme=${lightningAddressHashScheme}
walletPubkey=${walletPubkey}
lightningAddressHash=${lightningAddressHash}
messagingPubkey=${messagingPubkey}
signedAt=${signedAt}`;
}

function normalizeAndValidateMessagingIdentityV4(payload = {}) {
  const errors = [];
  const walletPubkey = normalizeWalletPubkey(payload.walletPubkey);
  const lightningAddressHash = normalizeClientHash(payload.lightningAddressHash);
  const lightningAddressHashScheme = typeof payload.lightningAddressHashScheme === 'string'
    ? payload.lightningAddressHashScheme.trim()
    : '';
  const messagingPubkey = normalizeMessagingPubkey(payload.messagingPubkey);
  const messagingIdentitySignature = normalizeSignature(payload.messagingIdentitySignature);
  const messagingIdentitySignatureVersion = parseIntegerValue(payload.messagingIdentitySignatureVersion);
  const messagingIdentitySignedAt = parseIntegerValue(payload.messagingIdentitySignedAt);

  if (!walletPubkey) errors.push('walletPubkey is required or invalid');
  if (!lightningAddressHash) errors.push('lightningAddressHash is required or invalid');
  if (!lightningAddressHashScheme) errors.push('lightningAddressHashScheme is required');
  if (!messagingPubkey) errors.push('messagingPubkey is required or invalid');
  if (!messagingIdentitySignature) errors.push('messagingIdentitySignature is required');
  if (!Number.isInteger(messagingIdentitySignatureVersion)) {
    errors.push('messagingIdentitySignatureVersion must be an integer');
  }
  if (!Number.isInteger(messagingIdentitySignedAt)) {
    errors.push('messagingIdentitySignedAt must be a unix timestamp in seconds');
  }

  if (lightningAddressHashScheme &&
      lightningAddressHashScheme !== LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME) {
    errors.push(`lightningAddressHashScheme must be ${LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME}`);
  }

  if (Number.isInteger(messagingIdentitySignatureVersion) &&
      messagingIdentitySignatureVersion !== MESSAGING_IDENTITY_V4_SIGNATURE_VERSION) {
    errors.push(
      `messagingIdentitySignatureVersion must be ${MESSAGING_IDENTITY_V4_SIGNATURE_VERSION}`
    );
  }

  const signedAtMs = Number.isInteger(messagingIdentitySignedAt)
    ? messagingIdentitySignedAt * 1000
    : null;
  if (signedAtMs != null && (!Number.isFinite(signedAtMs) || signedAtMs <= 0)) {
    errors.push('messagingIdentitySignedAt is invalid');
  }

  if (errors.length) {
    return { errors };
  }

  return {
    errors: [],
    binding: {
      walletPubkey,
      lightningAddressHash,
      lightningAddressHashScheme,
      messagingPubkey,
      messagingIdentitySignature,
      messagingIdentitySignatureVersion,
      messagingIdentitySignedAt,
      messagingIdentitySignedAtDate: new Date(signedAtMs),
    },
  };
}

function buildMessagingAccountHmacs(binding, options = {}) {
  return {
    walletPubkeyMessagingHmac: messagingDataHmac(binding.walletPubkey, options),
    lightningAddressMessagingHmac: messagingDataHmac(binding.lightningAddressHash, options),
    hmacVersion: MESSAGING_HMAC_VERSION,
  };
}

function buildMessagingPubkeyHmac(messagingPubkey, options = {}) {
  const normalized = normalizeMessagingPubkey(messagingPubkey);
  return normalized
    ? messagingDataHmac(normalized, options)
    : null;
}

function canonicalMessagingBindingPayload(binding = {}) {
  const signedAt = bindingSignedAtSeconds(
    binding.messagingIdentitySignedAtDate || binding.messagingIdentitySignedAt
  );
  if (!Number.isInteger(signedAt) || signedAt <= 0) {
    throw new Error('binding.messagingIdentitySignedAt is required or invalid');
  }

  return {
    walletPubkey: binding.walletPubkey,
    lightningAddressHash: binding.lightningAddressHash,
    lightningAddressHashScheme: binding.lightningAddressHashScheme,
    messagingPubkey: binding.messagingPubkey,
    messagingIdentitySignature: binding.messagingIdentitySignature,
    messagingIdentitySignatureVersion: binding.messagingIdentitySignatureVersion,
    messagingIdentitySignedAt: signedAt,
  };
}

function buildMessagingBindingPayloadHmac(binding, options = {}) {
  return messagingDataHmac(
    JSON.stringify(canonicalMessagingBindingPayload(binding)),
    options
  );
}

function buildEncryptedMessagingBindingStorageFields(binding, options = {}) {
  const canonicalBinding = canonicalMessagingBindingPayload(binding);
  const hmacs = buildMessagingAccountHmacs(canonicalBinding, options);
  const messagingPubkeyMessagingHmac = buildMessagingPubkeyHmac(
    canonicalBinding.messagingPubkey,
    options
  );
  const bindingPayloadMessagingHmac = buildMessagingBindingPayloadHmac(canonicalBinding, options);

  return {
    // Deprecated raw-field names are populated with deterministic HMACs so old
    // compound indexes remain satisfied without storing raw binding material.
    walletPubkey: hmacs.walletPubkeyMessagingHmac,
    lightningAddressHash: hmacs.lightningAddressMessagingHmac,
    lightningAddressHashScheme: canonicalBinding.lightningAddressHashScheme,
    messagingPubkey: messagingPubkeyMessagingHmac,
    messagingIdentitySignature: bindingPayloadMessagingHmac,
    messagingIdentitySignatureVersion: canonicalBinding.messagingIdentitySignatureVersion,
    messagingIdentitySignedAt: new Date(canonicalBinding.messagingIdentitySignedAt * 1000),
    messagingPubkeyMessagingHmac,
    bindingPayloadMessagingHmac,
    ...encryptMessagingBindingPayload(canonicalBinding, options),
  };
}

function bindingSignedAtSeconds(value) {
  if (!value) return null;

  const parsedInteger = parseIntegerValue(value);
  if (parsedInteger != null) return parsedInteger;

  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function hasEncryptedMessagingBindingPayload(bindingRecord) {
  return !!(
    bindingRecord?.bindingPayloadCiphertext &&
    bindingRecord?.bindingPayloadIv &&
    bindingRecord?.bindingPayloadAuthTag
  );
}

function materializeMessagingBindingV4(bindingRecord) {
  if (!bindingRecord) return null;

  const source = typeof bindingRecord.toObject === 'function'
    ? bindingRecord.toObject()
    : bindingRecord;
  const isEncrypted = hasEncryptedMessagingBindingPayload(source);
  let decryptedBinding = null;
  try {
    decryptedBinding = isEncrypted
      ? decryptMessagingBindingPayload(source)
      : canonicalMessagingBindingPayload(source);
  } catch (error) {
    if (isEncrypted) {
      throw error;
    }

    return {
      ...source,
      bindingPayloadKeyVersion: source.bindingPayloadKeyVersion || null,
      bindingPayloadEncrypted: false,
    };
  }

  return {
    ...source,
    ...decryptedBinding,
    messagingIdentitySignedAt: new Date(decryptedBinding.messagingIdentitySignedAt * 1000),
    messagingIdentitySignedAtSeconds: decryptedBinding.messagingIdentitySignedAt,
    bindingPayloadKeyVersion: source.bindingPayloadKeyVersion || null,
    bindingPayloadEncrypted: isEncrypted,
  };
}

function bindingMatchesStoredRecord(bindingRecord, binding) {
  const materializedBinding = materializeMessagingBindingV4(bindingRecord);
  if (!materializedBinding) return false;

  return (
    String(materializedBinding.walletPubkey || '') === binding.walletPubkey &&
    String(materializedBinding.lightningAddressHash || '') === binding.lightningAddressHash &&
    String(materializedBinding.lightningAddressHashScheme || '') === binding.lightningAddressHashScheme &&
    String(materializedBinding.messagingPubkey || '') === binding.messagingPubkey &&
    String(materializedBinding.messagingIdentitySignature || '') === binding.messagingIdentitySignature &&
    Number(materializedBinding.messagingIdentitySignatureVersion) === binding.messagingIdentitySignatureVersion &&
    bindingSignedAtSeconds(materializedBinding.messagingIdentitySignedAt) === binding.messagingIdentitySignedAt
  );
}

function stripMessagingBindingV4(bindingRecord) {
  const materializedBinding = materializeMessagingBindingV4(bindingRecord);
  if (!materializedBinding) return null;

  return {
    walletPubkey: materializedBinding.walletPubkey,
    lightningAddressHash: materializedBinding.lightningAddressHash,
    lightningAddressHashScheme: materializedBinding.lightningAddressHashScheme,
    messagingPubkey: materializedBinding.messagingPubkey,
    messagingIdentitySignature: materializedBinding.messagingIdentitySignature,
    messagingIdentitySignatureVersion: materializedBinding.messagingIdentitySignatureVersion,
    messagingIdentitySignedAt: bindingSignedAtSeconds(materializedBinding.messagingIdentitySignedAt),
    messagingIdentityUpdatedAt: materializedBinding.updatedAt || null,
  };
}

module.exports = {
  MESSAGING_BINDING_KEY_VERSION,
  MESSAGING_IDENTITY_V4_DOMAIN,
  MESSAGING_IDENTITY_V4_SIGNATURE_VERSION,
  bindingMatchesStoredRecord,
  buildEncryptedMessagingBindingStorageFields,
  buildMessagingAccountHmacs,
  buildMessagingBindingPayloadHmac,
  buildMessagingIdentityV4Message,
  buildMessagingPubkeyHmac,
  materializeMessagingBindingV4,
  normalizeAndValidateMessagingIdentityV4,
  stripMessagingBindingV4,
};
