const test = require('node:test');
const assert = require('node:assert/strict');

const {
  USER_HMAC_VERSION,
  normalizeLightningAddress,
  normalizeSparkAddress,
  normalizeWalletPubkey,
  userDataHmac,
} = require('../services/privacyCrypto');
const { buildUserPrivacyFields } = require('../services/userPrivacy');
const { buildUserPrivacyBackfillUpdate } = require('../scripts/backfillUserPrivacyHmacs');

const USER_PEPPER = 'user-privacy-backfill-test-pepper';

test('buildUserPrivacyFields returns no fields when the user pepper is not configured', () => {
  const originalPepper = process.env.USER_DATA_PEPPER;
  delete process.env.USER_DATA_PEPPER;

  try {
    assert.deepEqual(
      buildUserPrivacyFields({
        walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        lightningAddress: 'alice@example.invalid',
      }),
      {}
    );
  } finally {
    if (originalPepper) {
      process.env.USER_DATA_PEPPER = originalPepper;
    }
  }
});

test('buildUserPrivacyFields creates versioned HMACs for normalized user identifiers', () => {
  const fields = buildUserPrivacyFields({
    walletPubkey: ' 02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ',
    sparkAddress: ' spark1ABC123 ',
    lightningAddress: ' Alice@Example.Invalid ',
  }, {
    pepper: USER_PEPPER,
  });

  assert.deepEqual(fields, {
    walletPubkeyUserHmac: userDataHmac(
      normalizeWalletPubkey('02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      { pepper: USER_PEPPER }
    ),
    walletPubkeyUserHmacVersion: USER_HMAC_VERSION,
    sparkAddressUserHmac: userDataHmac(
      normalizeSparkAddress('spark1ABC123'),
      { pepper: USER_PEPPER }
    ),
    sparkAddressUserHmacVersion: USER_HMAC_VERSION,
    lightningAddressUserHmac: userDataHmac(
      normalizeLightningAddress('alice@example.invalid'),
      { pepper: USER_PEPPER }
    ),
    lightningAddressUserHmacVersion: USER_HMAC_VERSION,
  });
});

test('buildUserPrivacyBackfillUpdate returns only changed privacy fields', () => {
  const existingWalletHmac = userDataHmac(
    '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    { pepper: USER_PEPPER }
  );
  const update = buildUserPrivacyBackfillUpdate({
    _id: 'user-1',
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    walletPubkeyUserHmac: existingWalletHmac,
    walletPubkeyUserHmacVersion: USER_HMAC_VERSION,
    lightningAddress: 'Alice@Example.Invalid',
  }, {
    pepper: USER_PEPPER,
  });

  assert.deepEqual(Object.keys(update.$set).sort(), [
    'lightningAddressUserHmac',
    'lightningAddressUserHmacVersion',
  ]);
});

test('buildUserPrivacyBackfillUpdate returns null when stored HMACs are current', () => {
  const user = {
    _id: 'user-1',
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sparkAddress: 'spark1abc123',
    lightningAddress: 'alice@example.invalid',
  };
  Object.assign(user, buildUserPrivacyFields(user, { pepper: USER_PEPPER }));

  assert.equal(
    buildUserPrivacyBackfillUpdate(user, { pepper: USER_PEPPER }),
    null
  );
});
