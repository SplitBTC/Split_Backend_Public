const {
  USER_HMAC_VERSION,
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

  if (normalizedWalletPubkey) {
    fields.walletPubkeyUserHmac = userDataHmac(normalizedWalletPubkey, { pepper });
    fields.walletPubkeyUserHmacVersion = USER_HMAC_VERSION;
  }

  if (normalizedSparkAddress) {
    fields.sparkAddressUserHmac = userDataHmac(normalizedSparkAddress, { pepper });
    fields.sparkAddressUserHmacVersion = USER_HMAC_VERSION;
  }

  return fields;
}

module.exports = {
  buildUserPrivacyFields,
};
