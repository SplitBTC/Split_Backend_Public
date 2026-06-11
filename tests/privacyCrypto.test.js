const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  LIGHTNING_ADDRESS_CLIENT_HASH_PREFIX,
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  clientHashLightningAddress,
  decryptMessagingBindingPayload,
  decryptPushToken,
  decryptSparkAddress,
  encryptMessagingBindingPayload,
  encryptPushToken,
  encryptSparkAddress,
  messagingDataHmac,
  normalizeClientHash,
  normalizeLightningAddress,
  normalizeMessagingPubkey,
  normalizePushDeviceToken,
  normalizeSparkAddress,
  normalizeWalletPubkey,
  pushTokenLookupHmac,
  userDataHmac,
} = require('../services/privacyCrypto');

const USER_PEPPER = 'user-pepper-for-tests';
const MESSAGING_PEPPER = 'messaging-pepper-for-tests';
const PUSH_LOOKUP_PEPPER = 'push-lookup-pepper-for-tests';
const PUSH_KEY_HEX = '11'.repeat(32);
const PAYOUT_KEY_HEX = '22'.repeat(32);
const BINDING_KEY_HEX = '33'.repeat(32);

test('normalizes wallet and messaging public keys for deterministic storage', () => {
  assert.equal(
    normalizeWalletPubkey(' 0x02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA '),
    '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(
    normalizeWalletPubkey('A'.repeat(128)),
    `04${'a'.repeat(128)}`
  );
  assert.equal(normalizeWalletPubkey('not-a-key'), null);

  assert.equal(
    normalizeMessagingPubkey(' 02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB '),
    '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
  assert.equal(
    normalizeMessagingPubkey('B'.repeat(64)),
    'b'.repeat(64)
  );
  assert.equal(normalizeMessagingPubkey('04' + 'b'.repeat(128)), null);
});

test('normalizes Lightning and Spark addresses with their planned canonical rules', () => {
  assert.equal(
    normalizeLightningAddress(' Alice@example.invalid '),
    'alice@example.invalid'
  );
  assert.equal(normalizeLightningAddress('   '), null);

  assert.equal(normalizeSparkAddress(' spark1ABC123 '), 'spark1ABC123');
  assert.equal(normalizeSparkAddress('   '), null);
});

test('clientHashLightningAddress uses the agreed domain prefix and normalized address', () => {
  const expected = crypto
    .createHash('sha256')
    .update(`${LIGHTNING_ADDRESS_CLIENT_HASH_PREFIX}alice@example.invalid`, 'utf8')
    .digest('hex');

  assert.equal(clientHashLightningAddress(' Alice@example.invalid '), expected);
  assert.equal(normalizeClientHash(`0x${expected.toUpperCase()}`), expected);
  assert.equal(normalizeClientHash('abc'), null);
});

test('server HMACs are deterministic and separated by privacy domain', () => {
  const value = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const userHmac = userDataHmac(value, { pepper: USER_PEPPER });
  const userHmacAgain = userDataHmac(value, { pepper: USER_PEPPER });
  const messagingHmac = messagingDataHmac(value, { pepper: MESSAGING_PEPPER });

  assert.equal(userHmac, userHmacAgain);
  assert.notEqual(userHmac, messagingHmac);
  assert.match(userHmac, /^[0-9a-f]{64}$/);
  assert.match(messagingHmac, /^[0-9a-f]{64}$/);
});

test('push token lookup HMAC dedupes normalized tokens without exposing the token', () => {
  const apnsToken = 'A'.repeat(64);
  const normalized = normalizePushDeviceToken({
    platform: 'apns',
    deviceToken: apnsToken,
  });

  assert.equal(normalized, 'a'.repeat(64));
  assert.equal(
    pushTokenLookupHmac(normalized, { pepper: PUSH_LOOKUP_PEPPER }),
    pushTokenLookupHmac('a'.repeat(64), { pepper: PUSH_LOOKUP_PEPPER })
  );

  assert.equal(
    normalizePushDeviceToken({
      platform: 'fcm',
      deviceToken: ' FCMTokenCaseSensitive ',
    }),
    'FCMTokenCaseSensitive'
  );
});

test('encryptPushToken stores recoverable ciphertext and rejects tampering', () => {
  const encrypted = encryptPushToken('device-token-123', { key: PUSH_KEY_HEX });

  assert.notEqual(encrypted.deviceTokenCiphertext, 'device-token-123');
  assert.equal(
    decryptPushToken({ ...encrypted, key: PUSH_KEY_HEX }),
    'device-token-123'
  );

  assert.throws(
    () => decryptPushToken({
      ...encrypted,
      deviceTokenCiphertext: Buffer.from('tampered').toString('base64'),
      key: PUSH_KEY_HEX,
    }),
    /Unsupported state|authenticate|bad decrypt|Invalid authentication tag/i
  );
});

test('encryptSparkAddress stores recoverable payout destination ciphertext', () => {
  const encrypted = encryptSparkAddress(' spark1ABC123 ', { key: PAYOUT_KEY_HEX });

  assert.notEqual(encrypted.sparkAddressCiphertext, 'spark1ABC123');
  assert.equal(encrypted.sparkAddressKeyVersion, 'split-payout-destination-aes-gcm-v1');
  assert.equal(
    decryptSparkAddress({ ...encrypted, key: PAYOUT_KEY_HEX }),
    'spark1ABC123'
  );

  assert.throws(
    () => decryptSparkAddress({
      ...encrypted,
      sparkAddressAuthTag: Buffer.from('tampered').toString('base64'),
      key: PAYOUT_KEY_HEX,
    }),
    /Unsupported state|authenticate|bad decrypt|Invalid authentication tag/i
  );
});

test('encryptMessagingBindingPayload stores recoverable signed identity bindings', () => {
  const binding = {
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lightningAddressHash: clientHashLightningAddress('alice@example.invalid'),
    lightningAddressHashScheme: LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentitySignature: 'identity-signature',
    messagingIdentitySignatureVersion: 4,
    messagingIdentitySignedAt: 1_712_000_000,
  };

  const encrypted = encryptMessagingBindingPayload(binding, { key: BINDING_KEY_HEX });

  assert.notEqual(encrypted.bindingPayloadCiphertext, JSON.stringify(binding));
  assert.equal(encrypted.bindingPayloadKeyVersion, 'split-messaging-binding-aes-gcm-v1');
  assert.deepEqual(
    decryptMessagingBindingPayload({ ...encrypted, key: BINDING_KEY_HEX }),
    binding
  );

  assert.throws(
    () => decryptMessagingBindingPayload({
      ...encrypted,
      bindingPayloadAuthTag: Buffer.from('tampered').toString('base64'),
      key: BINDING_KEY_HEX,
    }),
    /Unsupported state|authenticate|bad decrypt|Invalid authentication tag/i
  );
});

test('privacy helpers fail fast when required secrets are missing', () => {
  assert.throws(
    () => userDataHmac('value'),
    /USER_DATA_PEPPER is required/
  );
  assert.throws(
    () => messagingDataHmac('value'),
    /MESSAGING_DATA_PEPPER is required/
  );
  assert.throws(
    () => pushTokenLookupHmac('value'),
    /PUSH_TOKEN_LOOKUP_PEPPER is required/
  );
  assert.throws(
    () => encryptSparkAddress('spark1ABC123'),
    /PAYOUT_DESTINATION_ENCRYPTION_KEY is required/
  );
  assert.throws(
    () => encryptMessagingBindingPayload({
      walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lightningAddressHash: clientHashLightningAddress('alice@example.invalid'),
      lightningAddressHashScheme: LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
      messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      messagingIdentitySignature: 'identity-signature',
      messagingIdentitySignatureVersion: 4,
      messagingIdentitySignedAt: 1_712_000_000,
    }),
    /MESSAGING_BINDING_ENCRYPTION_KEY is required/
  );
});
