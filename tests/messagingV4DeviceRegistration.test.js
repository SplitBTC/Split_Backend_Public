const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MESSAGING_IDENTITY_V4_DOMAIN,
} = require('../services/messagingV4Identity');
const {
  MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION,
  buildMessagingDeviceRegistrationV4Message,
  normalizeAndValidateMessagingDeviceRegistrationV4,
  stripMessagingDeviceRegistrationV4,
} = require('../services/messagingV4DeviceRegistration');

function buildPayload(overrides = {}) {
  return {
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    platform: 'apns',
    environment: 'dev',
    deviceToken: 'A'.repeat(64),
    registrationSignature: 'deadbeef',
    registrationSignatureVersion: MESSAGING_DEVICE_REGISTRATION_V4_SIGNATURE_VERSION,
    registrationSignedAt: 1_712_000_000,
    appVersion: '4.0.0',
    bundleId: 'com.example.app',
    ...overrides,
  };
}

test('buildMessagingDeviceRegistrationV4Message signs the v4 registration fields', () => {
  const payload = buildPayload({
    deviceToken: 'a'.repeat(64),
  });

  assert.equal(
    buildMessagingDeviceRegistrationV4Message({
      walletPubkey: payload.walletPubkey,
      messagingPubkey: payload.messagingPubkey,
      platform: payload.platform,
      environment: payload.environment,
      deviceToken: payload.deviceToken,
      signedAt: payload.registrationSignedAt,
      version: payload.registrationSignatureVersion,
    }),
    `SplitRewards Messaging Device Registration
version=2
domain=${MESSAGING_IDENTITY_V4_DOMAIN}
walletPubkey=${payload.walletPubkey}
messagingPubkey=${payload.messagingPubkey}
platform=apns
environment=dev
deviceToken=${'a'.repeat(64)}
signedAt=1712000000`
  );
});

test('normalizeAndValidateMessagingDeviceRegistrationV4 normalizes APNs tokens and metadata', () => {
  const normalized = normalizeAndValidateMessagingDeviceRegistrationV4(buildPayload({
    walletPubkey: ' 02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ',
    messagingPubkey: ' 02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
    platform: ' APNS ',
    environment: ' DEV ',
    registrationSignatureVersion: '2',
    registrationSignedAt: '1712000000',
    appVersion: ' 4.0.0 ',
    bundleId: ' com.example.app ',
  }));

  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.registration.walletPubkey, buildPayload().walletPubkey);
  assert.equal(normalized.registration.messagingPubkey, buildPayload().messagingPubkey);
  assert.equal(normalized.registration.platform, 'apns');
  assert.equal(normalized.registration.environment, 'dev');
  assert.equal(normalized.registration.deviceToken, 'a'.repeat(64));
  assert.equal(normalized.registration.appVersion, '4.0.0');
  assert.equal(normalized.registration.bundleId, 'com.example.app');
});

test('normalizeAndValidateMessagingDeviceRegistrationV4 preserves FCM token casing', () => {
  const normalized = normalizeAndValidateMessagingDeviceRegistrationV4(buildPayload({
    platform: 'fcm',
    deviceToken: ' FcmTokenCaseSensitiveValue1234567890 ',
  }));

  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.registration.deviceToken, 'FcmTokenCaseSensitiveValue1234567890');
});

test('normalizeAndValidateMessagingDeviceRegistrationV4 rejects wrong environment and version', () => {
  const normalized = normalizeAndValidateMessagingDeviceRegistrationV4(buildPayload({
    environment: 'stage',
    registrationSignatureVersion: 1,
  }));

  assert.match(normalized.errors.join('\n'), /environment is required/);
  assert.match(normalized.errors.join('\n'), /registrationSignatureVersion must be 2/);
});

test('stripMessagingDeviceRegistrationV4 does not expose encrypted token fields', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const stripped = stripMessagingDeviceRegistrationV4({
    _id: 'registration-1',
    messagingAccountId: 'account-1',
    platform: 'apns',
    environment: 'dev',
    deviceTokenCiphertext: 'secret',
    deviceTokenLookupHmac: 'lookup',
    appVersion: '4.0.0',
    bundleId: 'bundle',
    registrationSignedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });

  assert.deepEqual(Object.keys(stripped).sort(), [
    'appVersion',
    'bundleId',
    'createdAt',
    'environment',
    'lastSeenAt',
    'messagingAccountId',
    'platform',
    'registrationId',
    'registrationSignedAt',
    'updatedAt',
  ]);
});
