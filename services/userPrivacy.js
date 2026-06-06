const {
  USER_HMAC_VERSION,
  normalizeLightningAddress,
  normalizeSparkAddress,
  normalizeWalletPubkey,
  userDataHmac,
} = require('./privacyCrypto');

function hasUserDataPepper() {
  return !!process.env.USER_DATA_PEPPER;
}

function buildUserPrivacyFields({
  walletPubkey = null,
  sparkAddress = null,
  lightningAddress = null,
} = {}, {
  pepper = null,
  requirePepper = false,
} = {}) {
  if (!pepper && !hasUserDataPepper()) {
    if (requirePepper) {
      userDataHmac('pepper-check', { pepper });
    }

    return {};
  }

  const fields = {};
  const normalizedWalletPubkey = normalizeWalletPubkey(walletPubkey);
  const normalizedSparkAddress = normalizeSparkAddress(sparkAddress);
  const normalizedLightningAddress = normalizeLightningAddress(lightningAddress);

  if (normalizedWalletPubkey) {
    fields.walletPubkeyUserHmac = userDataHmac(normalizedWalletPubkey, { pepper });
    fields.walletPubkeyUserHmacVersion = USER_HMAC_VERSION;
  }

  if (normalizedSparkAddress) {
    fields.sparkAddressUserHmac = userDataHmac(normalizedSparkAddress, { pepper });
    fields.sparkAddressUserHmacVersion = USER_HMAC_VERSION;
  }

  if (normalizedLightningAddress) {
    fields.lightningAddressUserHmac = userDataHmac(normalizedLightningAddress, { pepper });
    fields.lightningAddressUserHmacVersion = USER_HMAC_VERSION;
  }

  return fields;
}

function assignUserPrivacyFields(user, identityValues, options = {}) {
  if (!user) return {};

  const fields = buildUserPrivacyFields(identityValues, options);
  for (const [key, value] of Object.entries(fields)) {
    user[key] = value;
  }

  return fields;
}

module.exports = {
  buildUserPrivacyFields,
  assignUserPrivacyFields,
};
