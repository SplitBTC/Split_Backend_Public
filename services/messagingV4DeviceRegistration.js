const {
  normalizeMessagingPubkey,
  normalizePushDeviceToken,
  normalizeWalletPubkey,
} = require('./privacyCrypto');
const {
  MESSAGING_IDENTITY_V4_DOMAIN,
} = require('./messagingV4Identity');

const MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION = 2;

function parseIntegerValue(value) {
  if (Number.isInteger(value)) return value;

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }

  return null;
}

function normalizeMessagingEnvironment(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['dev', 'prod'].includes(normalized) ? normalized : null;
}

function normalizeSignature(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidDeviceTokenForPlatform({ deviceToken, platform }) {
  if (!deviceToken) return false;

  if (platform === 'apns') {
    return /^[0-9a-f]{64,200}$/.test(deviceToken);
  }

  if (platform === 'fcm') {
    return /^\S{32,4096}$/.test(deviceToken);
  }

  return false;
}

function buildMessagingDeviceRegistrationV4Message({
  walletPubkey,
  messagingPubkey,
  platform,
  environment,
  deviceToken,
  signedAt,
  version = MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION,
  domain = MESSAGING_IDENTITY_V4_DOMAIN,
}) {
  return `SplitRewards Messaging Device Registration
version=${version}
domain=${domain}
walletPubkey=${walletPubkey}
messagingPubkey=${messagingPubkey}
platform=${platform}
environment=${environment}
deviceToken=${deviceToken}
signedAt=${signedAt}`;
}

function normalizeAndValidateMessagingDeviceRegistrationV4(payload = {}) {
  const errors = [];
  const walletPubkey = normalizeWalletPubkey(payload.walletPubkey);
  const messagingPubkey = normalizeMessagingPubkey(payload.messagingPubkey);
  const platform = typeof payload.platform === 'string'
    ? payload.platform.trim().toLowerCase()
    : '';
  const environment = normalizeMessagingEnvironment(payload.environment);
  const deviceToken = normalizePushDeviceToken({
    platform,
    deviceToken: payload.deviceToken,
  });
  const registrationSignature = normalizeSignature(payload.registrationSignature);
  const registrationSignatureVersion = parseIntegerValue(payload.registrationSignatureVersion);
  const registrationSignedAt = parseIntegerValue(payload.registrationSignedAt);
  const appVersion = typeof payload.appVersion === 'string'
    ? payload.appVersion.trim()
    : '';
  const bundleId = typeof payload.bundleId === 'string'
    ? payload.bundleId.trim()
    : '';

  if (!walletPubkey) errors.push('walletPubkey is required or invalid');
  if (!messagingPubkey) errors.push('messagingPubkey is required or invalid');
  if (!platform) errors.push('platform is required');
  if (!environment) errors.push('environment is required');
  if (!deviceToken) errors.push('deviceToken is required');
  if (!registrationSignature) errors.push('registrationSignature is required');
  if (!Number.isInteger(registrationSignatureVersion)) {
    errors.push('registrationSignatureVersion must be an integer');
  }
  if (!Number.isInteger(registrationSignedAt)) {
    errors.push('registrationSignedAt must be a unix timestamp in seconds');
  }

  if (platform && !['apns', 'fcm'].includes(platform)) {
    errors.push('platform must be apns or fcm');
  }

  if (platform && deviceToken && !isValidDeviceTokenForPlatform({ deviceToken, platform })) {
    errors.push('deviceToken format is invalid');
  }

  if (Number.isInteger(registrationSignatureVersion) &&
      registrationSignatureVersion !== MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION) {
    errors.push(
      `registrationSignatureVersion must be ${MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION}`
    );
  }

  const signedAtMs = Number.isInteger(registrationSignedAt)
    ? registrationSignedAt * 1000
    : null;
  if (signedAtMs != null && (!Number.isFinite(signedAtMs) || signedAtMs <= 0)) {
    errors.push('registrationSignedAt is invalid');
  }

  if (errors.length) {
    return { errors };
  }

  return {
    errors: [],
    registration: {
      walletPubkey,
      messagingPubkey,
      platform,
      environment,
      deviceToken,
      registrationSignature,
      registrationSignatureVersion,
      registrationSignedAt,
      registrationSignedAtDate: new Date(signedAtMs),
      appVersion: appVersion || null,
      bundleId: bundleId || null,
    },
  };
}

function stripMessagingDeviceRegistrationV4(registration) {
  return {
    registrationId: String(registration._id),
    messagingAccountId: String(registration.messagingAccountId),
    platform: registration.platform,
    environment: registration.environment,
    appVersion: registration.appVersion || null,
    bundleId: registration.bundleId || null,
    registrationSignedAt: registration.registrationSignedAt || null,
    lastSeenAt: registration.lastSeenAt || null,
    createdAt: registration.createdAt || null,
    updatedAt: registration.updatedAt || null,
  };
}

module.exports = {
  MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION,
  buildMessagingDeviceRegistrationV4Message,
  normalizeAndValidateMessagingDeviceRegistrationV4,
  stripMessagingDeviceRegistrationV4,
};
