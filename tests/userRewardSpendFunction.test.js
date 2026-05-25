const test = require('node:test');
const assert = require('node:assert/strict');

const RewardSpendPayment = require('../models/RewardSpendPayment');
const userRewardSpendFunction = require('../rewards/userRewardSpendFunction');

function merchantQueryResult(value) {
  return {
    select() {
      return {
        lean: async () => value,
      };
    },
  };
}

function createModelHarness({ merchant = { _id: 'merchant-1' }, createError = null } = {}) {
  const calls = {
    userUpdates: [],
    rewardSpendPaymentCreates: [],
    merchantFinds: [],
    platformUpdates: [],
  };

  return {
    calls,
    models: {
      User: {
        updateOne: async (...args) => {
          calls.userUpdates.push(args);
        },
      },
      RewardSpendPayment: {
        create: async (payload) => {
          calls.rewardSpendPaymentCreates.push(payload);
          if (createError) {
            throw createError;
          }
          return payload;
        },
      },
      MerchantPubKey: {
        findOne: (query) => {
          calls.merchantFinds.push(query);
          return merchantQueryResult(merchant);
        },
      },
      PlatformAnalytics: {
        updateOne: async (...args) => {
          calls.platformUpdates.push(args);
        },
      },
    },
  };
}

function baseArgs(models, overrides = {}) {
  return {
    ...models,
    userId: '507f1f77bcf86cd799439011',
    usdAmountCentsNum: 1299,
    btcAmountSatsNum: 21000,
    destinationPubkey: 'merchant-pubkey',
    network: 'lightning',
    direction: 'sent',
    finalStatus: 'Completed',
    ...overrides,
  };
}

test('RewardSpendPayment uses paymentHash as a partial global unique key', () => {
  const indexes = RewardSpendPayment.schema.indexes();
  assert.ok(
    indexes.some(([fields, options]) => (
      fields.paymentHash === 1 &&
      options &&
      options.unique === true &&
      options.partialFilterExpression?.paymentHash?.$type === 'string'
    ))
  );
});

test('records a reward spend payment before incrementing reward totals', async () => {
  const { calls, models } = createModelHarness();

  const result = await userRewardSpendFunction(baseArgs(models, {
    paymentHash: ' payment-hash-1 ',
  }));

  assert.deepEqual(result, {
    rewardSpendApplied: true,
    merchantMatched: true,
    rewardSpendPaymentRecorded: true,
    duplicatePaymentHash: false,
  });

  assert.equal(calls.rewardSpendPaymentCreates.length, 1);
  assert.equal(calls.rewardSpendPaymentCreates[0].paymentHash, 'payment-hash-1');
  assert.equal(calls.rewardSpendPaymentCreates[0].destinationPubkey, 'merchant-pubkey');
  assert.equal(calls.rewardSpendPaymentCreates[0].btcAmountSats, 21000);
  assert.equal(calls.rewardSpendPaymentCreates[0].usdAmountCents, 1299);
  assert.equal(calls.rewardSpendPaymentCreates[0].network, 'lightning');
  assert.equal(calls.rewardSpendPaymentCreates[0].direction, 'sent');
  assert.equal(calls.rewardSpendPaymentCreates[0].status, 'Completed');
  assert.match(calls.rewardSpendPaymentCreates[0].monthKey, /^\d{4}-\d{2}$/);

  assert.equal(calls.userUpdates.length, 1);
  assert.equal(calls.platformUpdates.length, 1);
});

test('normalizes merchant destination pubkeys before lookup and ledger insert', async () => {
  const { calls, models } = createModelHarness();

  await userRewardSpendFunction(baseArgs(models, {
    destinationPubkey: ' MERCHANT-PUBKEY ',
    paymentHash: 'payment-hash-normalized',
  }));

  assert.deepEqual(calls.merchantFinds[0], {
    pubkey: {
      $regex: '^merchant-pubkey$',
      $options: 'i',
    },
  });
  assert.equal(calls.rewardSpendPaymentCreates[0].destinationPubkey, 'merchant-pubkey');
});

test('duplicate payment hashes do not increment reward spend again', async () => {
  const duplicateError = new Error('duplicate key');
  duplicateError.code = 11000;
  const { calls, models } = createModelHarness({ createError: duplicateError });

  const result = await userRewardSpendFunction(baseArgs(models, {
    paymentHash: 'payment-hash-1',
  }));

  assert.deepEqual(result, {
    rewardSpendApplied: false,
    merchantMatched: true,
    rewardSpendPaymentRecorded: false,
    duplicatePaymentHash: true,
  });

  assert.equal(calls.rewardSpendPaymentCreates.length, 1);
  assert.equal(calls.userUpdates.length, 0);
  assert.equal(calls.platformUpdates.length, 0);
});

test('does not record eligible merchant payments without paymentHash', async () => {
  const { calls, models } = createModelHarness();

  const result = await userRewardSpendFunction(baseArgs(models));

  assert.equal(result.rewardSpendApplied, false);
  assert.equal(result.merchantMatched, false);
  assert.equal(result.rewardSpendPaymentRecorded, false);
  assert.equal(result.duplicatePaymentHash, false);
  assert.equal(calls.rewardSpendPaymentCreates.length, 0);
  assert.equal(calls.userUpdates.length, 0);
  assert.equal(calls.platformUpdates.length, 0);
});

test('non-merchant payments do not create reward spend ledger rows', async () => {
  const { calls, models } = createModelHarness({ merchant: null });

  const result = await userRewardSpendFunction(baseArgs(models, {
    paymentHash: 'payment-hash-2',
  }));

  assert.deepEqual(result, {
    rewardSpendApplied: false,
    merchantMatched: false,
    rewardSpendPaymentRecorded: false,
    duplicatePaymentHash: false,
  });

  assert.equal(calls.rewardSpendPaymentCreates.length, 0);
  assert.equal(calls.userUpdates.length, 0);
  assert.equal(calls.platformUpdates.length, 1);
});
