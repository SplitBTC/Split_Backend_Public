const {
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  MESSAGING_HMAC_VERSION,
  messagingDataHmac,
  normalizeClientHash,
  normalizeMessagingPubkey,
  normalizeWalletPubkey,
} = require('./privacyCrypto');

const MESSAGING_IDENTITY_V4_SIGNATURE_VERSION = 4;
const MESSAGING_IDENTITY_V4_DOMAIN = process.env.MESSAGING_V4_IDENTITY_DOMAIN ||
  'splitrewards.messaging';

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

function bindingSignedAtSeconds(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function bindingMatchesStoredRecord(bindingRecord, binding) {
  return (
    String(bindingRecord.walletPubkey || '') === binding.walletPubkey &&
    String(bindingRecord.lightningAddressHash || '') === binding.lightningAddressHash &&
    String(bindingRecord.lightningAddressHashScheme || '') === binding.lightningAddressHashScheme &&
    String(bindingRecord.messagingPubkey || '') === binding.messagingPubkey &&
    String(bindingRecord.messagingIdentitySignature || '') === binding.messagingIdentitySignature &&
    Number(bindingRecord.messagingIdentitySignatureVersion) === binding.messagingIdentitySignatureVersion &&
    bindingSignedAtSeconds(bindingRecord.messagingIdentitySignedAt) === binding.messagingIdentitySignedAt
  );
}

function stripMessagingBindingV4(bindingRecord) {
  if (!bindingRecord) return null;

  return {
    walletPubkey: bindingRecord.walletPubkey,
    lightningAddressHash: bindingRecord.lightningAddressHash,
    lightningAddressHashScheme: bindingRecord.lightningAddressHashScheme,
    messagingPubkey: bindingRecord.messagingPubkey,
    messagingIdentitySignature: bindingRecord.messagingIdentitySignature,
    messagingIdentitySignatureVersion: bindingRecord.messagingIdentitySignatureVersion,
    messagingIdentitySignedAt: bindingSignedAtSeconds(bindingRecord.messagingIdentitySignedAt),
    messagingIdentityUpdatedAt: bindingRecord.updatedAt || null,
  };
}

module.exports = {
  MESSAGING_IDENTITY_V4_DOMAIN,
  MESSAGING_IDENTITY_V4_SIGNATURE_VERSION,
  bindingMatchesStoredRecord,
  buildMessagingAccountHmacs,
  buildMessagingIdentityV4Message,
  buildMessagingPubkeyHmac,
  normalizeAndValidateMessagingIdentityV4,
  stripMessagingBindingV4,
};
