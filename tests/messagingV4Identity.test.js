const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  clientHashLightningAddress,
  messagingDataHmac,
} = require('../services/privacyCrypto');
const {
  MESSAGING_IDENTITY_V4_DOMAIN,
  MESSAGING_IDENTITY_V4_SIGNATURE_VERSION,
  bindingMatchesStoredRecord,
  buildMessagingAccountHmacs,
  buildMessagingIdentityV4Message,
  buildMessagingPubkeyHmac,
  normalizeAndValidateMessagingIdentityV4,
  stripMessagingBindingV4,
} = require('../services/messagingV4Identity');

const MESSAGING_PEPPER = 'messaging-v4-identity-test-pepper';

function buildPayload(overrides = {}) {
  return {
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lightningAddressHash: clientHashLightningAddress('alice@example.invalid'),
    lightningAddressHashScheme: LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentitySignature: 'deadbeef',
    messagingIdentitySignatureVersion: MESSAGING_IDENTITY_V4_SIGNATURE_VERSION,
    messagingIdentitySignedAt: 1_712_000_000,
    ...overrides,
  };
}

test('buildMessagingIdentityV4Message signs the privacy-adjusted binding fields', () => {
  const payload = buildPayload();

  assert.equal(
    buildMessagingIdentityV4Message({
      walletPubkey: payload.walletPubkey,
      lightningAddressHash: payload.lightningAddressHash,
      lightningAddressHashScheme: payload.lightningAddressHashScheme,
      messagingPubkey: payload.messagingPubkey,
      signedAt: payload.messagingIdentitySignedAt,
      version: payload.messagingIdentitySignatureVersion,
    }),
    `SplitRewards Messaging Identity Authorization
version=4
domain=${MESSAGING_IDENTITY_V4_DOMAIN}
hashScheme=${LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME}
walletPubkey=${payload.walletPubkey}
lightningAddressHash=${payload.lightningAddressHash}
messagingPubkey=${payload.messagingPubkey}
signedAt=1712000000`
  );
});

test('normalizeAndValidateMessagingIdentityV4 accepts normalized v4 bindings', () => {
  const normalized = normalizeAndValidateMessagingIdentityV4(buildPayload({
    walletPubkey: ' 02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ',
    lightningAddressHash: `0x${clientHashLightningAddress('Alice@Example.Invalid').toUpperCase()}`,
    messagingPubkey: ' 02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
    messagingIdentitySignatureVersion: '4',
    messagingIdentitySignedAt: '1712000000',
  }));

  assert.deepEqual(normalized.errors, []);
  assert.equal(
    normalized.binding.walletPubkey,
    '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(
    normalized.binding.lightningAddressHash,
    clientHashLightningAddress('alice@example.invalid')
  );
  assert.equal(
    normalized.binding.messagingPubkey,
    '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
  assert.equal(normalized.binding.messagingIdentitySignatureVersion, 4);
  assert.equal(normalized.binding.messagingIdentitySignedAt, 1_712_000_000);
});

test('normalizeAndValidateMessagingIdentityV4 rejects unsupported hash schemes and versions', () => {
  const normalized = normalizeAndValidateMessagingIdentityV4(buildPayload({
    lightningAddressHashScheme: 'wrong-scheme',
    messagingIdentitySignatureVersion: 3,
  }));

  assert.match(
    normalized.errors.join('\n'),
    /lightningAddressHashScheme must be split-ln-address-sha256-v1/
  );
  assert.match(
    normalized.errors.join('\n'),
    /messagingIdentitySignatureVersion must be 4/
  );
});

test('buildMessagingAccountHmacs separates wallet and Lightning-hash lookups', () => {
  const { binding } = normalizeAndValidateMessagingIdentityV4(buildPayload());
  const hmacs = buildMessagingAccountHmacs(binding, { pepper: MESSAGING_PEPPER });

  assert.deepEqual(hmacs, {
    walletPubkeyMessagingHmac: messagingDataHmac(binding.walletPubkey, {
      pepper: MESSAGING_PEPPER,
    }),
    lightningAddressMessagingHmac: messagingDataHmac(binding.lightningAddressHash, {
      pepper: MESSAGING_PEPPER,
    }),
    hmacVersion: 'split-messaging-hmac-sha256-v1',
  });
});

test('bindingMatchesStoredRecord and stripMessagingBindingV4 handle stored date values', () => {
  const { binding } = normalizeAndValidateMessagingIdentityV4(buildPayload());
  const stored = {
    ...binding,
    messagingIdentitySignedAt: binding.messagingIdentitySignedAtDate,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  assert.equal(bindingMatchesStoredRecord(stored, binding), true);
  assert.deepEqual(stripMessagingBindingV4(stored), {
    walletPubkey: binding.walletPubkey,
    lightningAddressHash: binding.lightningAddressHash,
    lightningAddressHashScheme: binding.lightningAddressHashScheme,
    messagingPubkey: binding.messagingPubkey,
    messagingIdentitySignature: binding.messagingIdentitySignature,
    messagingIdentitySignatureVersion: 4,
    messagingIdentitySignedAt: 1_712_000_000,
    messagingIdentityUpdatedAt: stored.updatedAt,
  });
});

test('buildMessagingPubkeyHmac returns a lookup HMAC for valid messaging keys', () => {
  assert.equal(
    buildMessagingPubkeyHmac(
      '02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      { pepper: MESSAGING_PEPPER }
    ),
    messagingDataHmac(
      '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      { pepper: MESSAGING_PEPPER }
    )
  );
});
