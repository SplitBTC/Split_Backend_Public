// userRewardSpendFunction.js
/**
 * Records one permanent RewardSpendPayment row for each eligible lightning purchase,
 * and records transaction + volume into PlatformAnalytics (sats + cents).
 *
 * NOTE: Always increments platform-wide transactions/volume.
 *       Only increments reward ledger + lifetimeMerchantSpendCents when eligible merchant.
 *       A duplicate payment hash is treated as already accounted and skipped.
 */
async function userRewardSpendFunction({
  User,
  RewardSpendPayment,
  MerchantPubKey,
  PlatformAnalytics,
  userId,
  usdAmountCentsNum,
  btcAmountSatsNum,
  destinationPubkey,
  network,
  direction,
  finalStatus,
  paymentHash,
}) {
  const result = {
    rewardSpendApplied: false,
    merchantMatched: false,
    rewardSpendPaymentRecorded: false,
    duplicatePaymentHash: false,
  };

  try {
    // Guards for when this endpoint should apply
    if (finalStatus !== 'Completed') return result;
    if (network !== 'lightning') return result;
    if (direction !== 'sent') return result;

    if (!Number.isFinite(usdAmountCentsNum) || usdAmountCentsNum <= 0) return result;
    if (!Number.isInteger(btcAmountSatsNum) || btcAmountSatsNum <= 0) return result;

    const normalizedPaymentHash =
      typeof paymentHash === 'string' && paymentHash.trim().length > 0
        ? paymentHash.trim()
        : null;
    const normalizedDestinationPubkey =
      typeof destinationPubkey === 'string' && destinationPubkey.trim().length > 0
        ? destinationPubkey.trim().toLowerCase()
        : null;

    if (!normalizedPaymentHash) return result;

    // Always update platform-wide totals
    const inc = {
      transactions: 1,
      'transactionVolume.btcSats': btcAmountSatsNum,
      'transactionVolume.usdCents': usdAmountCentsNum,
    };

    // Merchant attribution only if we have a destination and it matches an eligible merchant
    let eligible = null;
    if (normalizedDestinationPubkey) {
      eligible = await MerchantPubKey.findOne(merchantPubkeyQuery(normalizedDestinationPubkey))
        .select('_id')
        .lean();
    }

    if (eligible) {
      result.merchantMatched = true;

      inc.merchantTransactions = 1;
      inc['merchantVolume.btcSats'] = btcAmountSatsNum;
      inc['merchantVolume.usdCents'] = usdAmountCentsNum;

      // Compute current monthKey in UTC (YYYY-MM)
      const monthKey = new Date().toISOString().slice(0, 7);

      try {
        const paymentPayload = {
          userId,
          destinationPubkey: normalizedDestinationPubkey,
          btcAmountSats: btcAmountSatsNum,
          usdAmountCents: usdAmountCentsNum,
          network,
          direction,
          status: finalStatus,
          monthKey,
          occurredAt: new Date(),
        };

        paymentPayload.paymentHash = normalizedPaymentHash;

        await RewardSpendPayment.create(paymentPayload);
        result.rewardSpendPaymentRecorded = true;
      } catch (err) {
        if (err && err.code === 11000) {
          result.duplicatePaymentHash = true;
          return result;
        }

        throw err;
      }

      // Track lifetime merchant spend on user (no reward credits anymore)
      await User.updateOne(
        { _id: userId },
        { $inc: { lifetimeMerchantSpendCents: usdAmountCentsNum } }
      );

      result.rewardSpendApplied = true;
    }

    await PlatformAnalytics.updateOne(
      { _id: 'platform' },
      { $inc: inc },
      { upsert: true }
    );

    return result;
  } catch (err) {
    console.error('userRewardSpendFunction error:', err);
    return result;
  }
}

function merchantPubkeyQuery(pubkey) {
  return {
    pubkey: {
      $regex: `^${escapeRegExp(pubkey)}$`,
      $options: 'i',
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = userRewardSpendFunction;
