const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

process.env.secretKey = process.env.secretKey || 'split-backend-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const UserBlockV4 = require('../models/UserBlockV4');
const DirectMessageV4 = require('../models/DirectMessageV4');
const MessageAttachmentV4 = require('../models/MessageAttachmentV4');
const MessagingAccount = require('../models/MessagingAccount');
const MessagingBinding = require('../models/MessagingBinding');
const MessagingDeviceRegistrationV4 = require('../models/MessagingDeviceRegistrationV4');
const PlatformWallet = require('../models/PlatformWallet');
const RewardPayoutAllocation = require('../models/RewardPayoutAllocation');
const RewardSpendPayment = require('../models/RewardSpendPayment');
const MerchantPubKey = require('../models/MerchantPubKey');
const s3Client = require('../integrations/r2');
const sessionHelper = require('../auth/sessionHelper');
const iOSEndPoints = require('../routes/iOSEndPoints');
const MessageEndPoints = require('../routes/MessageEndPoints');
const { getRewardsMinimumVersion } = iOSEndPoints;
const {
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  messagingDataHmac,
  userDataHmac,
} = require('../services/privacyCrypto');
const {
  buildMessagingAccountHmacs,
  buildMessagingPubkeyHmac,
} = require('../services/messagingV4Identity');

function createJsonApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(iOSEndPoints);
  app.use(MessageEndPoints);
  return app;
}

test('getRewardsMinimumVersion returns the current forced app versions', () => {
  assert.equal(getRewardsMinimumVersion(), '4.4.3');
  assert.equal(getRewardsMinimumVersion('ios'), '4.4.3');
  assert.equal(getRewardsMinimumVersion('android'), '0.7.3');
});

async function withServer(run) {
  const app = createJsonApp();
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a valid address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function maybeWithServer(t, run) {
  try {
    await withServer(run);
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('Local socket binding is not permitted in this environment.');
      return;
    }

    throw error;
  }
}

function authCookie(userId, pubkey = null) {
  const token = jwt.sign(
    pubkey ? { userId, pubkey } : { userId },
    process.env.secretKey,
    { expiresIn: '1h' }
  );

  return `jwtToken=${token}`;
}

function queryResult(value) {
  return {
    select: async () => value,
  };
}

function querySelectLeanResult(value) {
  return {
    select() {
      return {
        lean: async () => value,
      };
    },
  };
}

function buildUser(overrides = {}) {
  return {
    _id: 'user-1',
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides,
  };
}

function withPatchedMethods(patches, fn) {
  const originals = patches.map(({ target, key }) => ({
    target,
    key,
    value: target[key],
  }));

  patches.forEach(({ target, key, value }) => {
    target[key] = value;
  });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      originals.forEach(({ target, key, value }) => {
        target[key] = value;
      });
    });
}

function queryChainResult(value) {
  return {
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value,
  };
}

test('POST /v2/account/delete verifies signed wallet proof without stored raw user pubkey', async (t) => {
  const originalUserPepper = process.env.USER_DATA_PEPPER;
  const originalMessagingPepper = process.env.MESSAGING_DATA_PEPPER;
  process.env.USER_DATA_PEPPER = 'account-delete-user-hmac-test-pepper';
  process.env.MESSAGING_DATA_PEPPER = 'account-delete-v4-test-pepper';

  const walletPubkey = '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const user = buildUser({
    _id: new mongoose.Types.ObjectId(),
    walletPubkey: undefined,
    walletPubkeyUserHmac: userDataHmac(walletPubkey, {
      pepper: process.env.USER_DATA_PEPPER,
    }),
    profilePicUrl: 'https://cdn.example.invalid/profile-pictures/user-v2.png',
    async deleteOne() {
      this.didDelete = true;
      return { deletedCount: 1 };
    },
  });
  const messagingAccountId = new mongoose.Types.ObjectId();
  const messagingAccountFindFilters = [];
  const noncePeekCalls = [];
  const nonceConsumeCalls = [];
  const signatureVerificationCalls = [];

  try {
    await withPatchedMethods([
      { target: User, key: 'findById', value: () => queryResult(user) },
      {
        target: sessionHelper,
        key: 'peekNonce',
        value: (nonce, options) => {
          noncePeekCalls.push({ nonce, options });
          return {
            messageToSign: 'delete-account-message',
            purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
          };
        },
      },
      {
        target: sessionHelper,
        key: 'verifyBreezSignedMessage',
        value: (args) => {
          signatureVerificationCalls.push(args);
          return true;
        },
      },
      {
        target: sessionHelper,
        key: 'consumeNonce',
        value: (nonce, options) => {
          nonceConsumeCalls.push({ nonce, options });
          return true;
        },
      },
      {
        target: MessagingAccount,
        key: 'findOne',
        value: (filter) => {
          messagingAccountFindFilters.push(filter);
          return queryResult({ _id: messagingAccountId });
        },
      },
      { target: MessageAttachmentV4, key: 'find', value: () => queryResult([]) },
      { target: MessageAttachmentV4, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
      { target: DirectMessageV4, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
      { target: UserBlockV4, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
      { target: MessagingDeviceRegistrationV4, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
      { target: MessagingBinding, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
      { target: MessagingAccount, key: 'deleteOne', value: async () => ({ deletedCount: 1 }) },
      { target: s3Client, key: 'send', value: async () => ({}) },
    ], async () => {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/v2/account/delete`, {
          method: 'POST',
          headers: {
            Cookie: authCookie(String(user._id)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            walletPubkey,
            nonce: 'delete-nonce',
            signature: 'delete-signature',
          }),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(user.didDelete, true);
        assert.deepEqual(noncePeekCalls, [{
          nonce: 'delete-nonce',
          options: { purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE },
        }]);
        assert.deepEqual(signatureVerificationCalls, [{
          message: 'delete-account-message',
          pubkey: walletPubkey,
          signature: 'delete-signature',
        }]);
        assert.deepEqual(nonceConsumeCalls, [{
          nonce: 'delete-nonce',
          options: { purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE },
        }]);
        assert.deepEqual(messagingAccountFindFilters, [{
          walletPubkeyMessagingHmac: messagingDataHmac(walletPubkey),
        }]);
        assert.equal(body.deleted.v4MessagingAccount, 1);
      });
    });
  } finally {
    if (originalUserPepper) {
      process.env.USER_DATA_PEPPER = originalUserPepper;
    } else {
      delete process.env.USER_DATA_PEPPER;
    }

    if (originalMessagingPepper) {
      process.env.MESSAGING_DATA_PEPPER = originalMessagingPepper;
    } else {
      delete process.env.MESSAGING_DATA_PEPPER;
    }
  }
});

test('GET /rewards-version-check returns the enforced minimum version by default', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, '4.4.3');
    assert.equal(body.minimumVersion, getRewardsMinimumVersion());
  });
});

test('GET /rewards-version-check returns the enforced iOS minimum version when platform=ios', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check?platform=ios`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, '4.4.3');
    assert.equal(body.minimumVersion, getRewardsMinimumVersion('ios'));
  });
});

test('GET /rewards-version-check returns the enforced Android minimum version when platform=android', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check?platform=android`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, '0.7.3');
    assert.equal(body.minimumVersion, getRewardsMinimumVersion('android'));
  });
});

test('GET /v1/RewardStats returns lifetime paid rewards from RewardPayoutAllocation', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const aggregateCalls = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult({ _id: userId }) },
    {
      target: PlatformWallet,
      key: 'findOne',
      value: () => querySelectLeanResult({ balanceSats: 250_000 }),
    },
    {
      target: RewardSpendPayment,
      key: 'aggregate',
      value: async (pipeline) => {
        aggregateCalls.push({ model: 'RewardSpendPayment', pipeline });
        const match = pipeline[0]?.$match || {};

        if (match.userId) {
          assert.equal(String(match.userId), String(userId));
          return [{
            _id: userId,
            rewardSpendCents: 2_500,
            transactions: 2,
          }];
        }

        return [{
          _id: match.monthKey,
          rewardSpendCents: 10_000,
          transactions: 8,
        }];
      },
    },
    {
      target: RewardPayoutAllocation,
      key: 'aggregate',
      value: async (pipeline) => {
        aggregateCalls.push({ model: 'RewardPayoutAllocation', pipeline });
        assert.deepEqual(pipeline[0]?.$match, {
          userId: new mongoose.Types.ObjectId(String(userId)),
          paid: true,
        });

        return [{
          _id: null,
          lifetimeEarningsSats: 42_123,
        }];
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/RewardStats`, {
        headers: {
          Cookie: authCookie(String(userId)),
        },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.monthlyPot.sats, 250_000);
      assert.equal(body.platform.rewardSpendCents, 10_000);
      assert.equal(body.platform.transactions, 8);
      assert.equal(body.user.rewardSpendCents, 2_500);
      assert.equal(body.user.transactions, 2);
      assert.equal(body.stats.shareBps, 2_500);
      assert.equal(body.stats.projectedEarningsSats, 62_500);
      assert.equal(body.stats.lifetimeEarningsSats, 42_123);
      assert.equal(
        aggregateCalls.filter((call) => call.model === 'RewardPayoutAllocation').length,
        1
      );
    });
  });
});

test('GET /v1/reward-merchant-pubkey-hashes returns hashes and backfills missing values without auth', async (t) => {
  const merchantRecords = [
    {
      _id: 'merchant-hash-1',
      pubkey: ' 03MERCHANTPUBKEY ',
    },
    {
      _id: 'merchant-hash-2',
      pubkey: '02existingmerchant',
      pubkeyHash: MerchantPubKey.hashPubkey('02existingmerchant'),
      pubkeyHashVersion: MerchantPubKey.PUBKEY_HASH_VERSION,
    },
  ];
  const updateCalls = [];

  await withPatchedMethods([
    {
      target: MerchantPubKey,
      key: 'find',
      value: () => ({
        select: () => ({
          lean: async () => merchantRecords,
        }),
      }),
    },
    {
      target: MerchantPubKey,
      key: 'updateOne',
      value: async (filter, update) => {
        updateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/reward-merchant-pubkey-hashes`);
      const body = await response.json();

      const expectedBackfilledHash = MerchantPubKey.hashPubkey('03merchantpubkey');
      const expectedExistingHash = MerchantPubKey.hashPubkey('02existingmerchant');

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.algorithm, 'sha256');
      assert.equal(body.normalization, 'trim-lowercase');
      assert.equal(body.hashVersion, MerchantPubKey.PUBKEY_HASH_VERSION);
      assert.equal(body.hashPrefix, MerchantPubKey.PUBKEY_HASH_PREFIX);
      assert.equal(body.cacheTtlSeconds, 3600);
      assert.equal(body.count, 2);
      assert.deepEqual(body.hashes, [expectedExistingHash, expectedBackfilledHash].sort());
      assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
      assert.ok(response.headers.get('etag'));
      assert.equal(updateCalls.length, 1);
      assert.deepEqual(updateCalls[0].filter, { _id: 'merchant-hash-1' });
      assert.equal(updateCalls[0].update.$set.pubkeyHash, expectedBackfilledHash);
      assert.equal(updateCalls[0].update.$set.pubkeyHashVersion, MerchantPubKey.PUBKEY_HASH_VERSION);
      assert.ok(updateCalls[0].update.$set.pubkeyHashUpdatedAt instanceof Date);
    });
  });
});

test('GET /v1/reward-merchant-pubkey-hashes supports ETag revalidation', async (t) => {
  const merchantRecords = [
    {
      _id: 'merchant-hash-etag-1',
      pubkey: '03merchantpubkey',
      pubkeyHash: MerchantPubKey.hashPubkey('03merchantpubkey'),
      pubkeyHashVersion: MerchantPubKey.PUBKEY_HASH_VERSION,
    },
  ];

  await withPatchedMethods([
    {
      target: MerchantPubKey,
      key: 'find',
      value: () => ({
        select: () => ({
          lean: async () => merchantRecords,
        }),
      }),
    },
    {
      target: MerchantPubKey,
      key: 'updateOne',
      value: async () => {
        throw new Error('No backfill should be needed');
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const firstResponse = await fetch(`${baseUrl}/v1/reward-merchant-pubkey-hashes`);
      const etag = firstResponse.headers.get('etag');
      const secondResponse = await fetch(`${baseUrl}/v1/reward-merchant-pubkey-hashes`, {
        headers: {
          'If-None-Match': etag,
        },
      });

      assert.equal(firstResponse.status, 200);
      assert.ok(etag);
      assert.equal(secondResponse.status, 304);
    });
  });
});

test('GET /messaging/v4/identity resolves authenticated wallet from client pubkey HMAC', async (t) => {
  const originalMessagingPepper = process.env.MESSAGING_DATA_PEPPER;
  const originalUserPepper = process.env.USER_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-client-wallet-test-pepper';
  process.env.USER_DATA_PEPPER = 'messaging-v4-user-wallet-test-pepper';

  const walletPubkey = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const accountId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439031');
  const bindingId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439032');
  const selectedUserFields = [];
  const accountFindCalls = [];
  const activeBinding = {
    _id: bindingId,
    active: true,
    walletPubkey,
    lightningAddressHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lightningAddressHashScheme: LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentitySignature: 'identity-signature',
    messagingIdentitySignatureVersion: 4,
    messagingIdentitySignedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => ({
        select: async (fields) => {
          selectedUserFields.push(fields);
          return {
            _id: accountId,
            walletPubkeyUserHmac: userDataHmac(walletPubkey),
          };
        },
      }),
    },
    {
      target: MessagingAccount,
      key: 'findOne',
      value: async (filter) => {
        accountFindCalls.push(filter);
        return {
          _id: accountId,
          activeBindingId: bindingId,
        };
      },
    },
    { target: MessagingBinding, key: 'findById', value: async () => activeBinding },
  ], async () => {
    try {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/messaging/v4/identity`, {
          headers: {
            Cookie: authCookie(String(accountId)),
            'X-Split-Wallet-Pubkey': walletPubkey,
          },
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(body.binding.walletPubkey, walletPubkey);
        assert.deepEqual(selectedUserFields, ['_id walletPubkeyUserHmac']);
        assert.deepEqual(accountFindCalls[0], {
          walletPubkeyMessagingHmac: messagingDataHmac(walletPubkey),
        });
      });
    } finally {
      if (originalMessagingPepper == null) {
        delete process.env.MESSAGING_DATA_PEPPER;
      } else {
        process.env.MESSAGING_DATA_PEPPER = originalMessagingPepper;
      }

      if (originalUserPepper == null) {
        delete process.env.USER_DATA_PEPPER;
      } else {
        process.env.USER_DATA_PEPPER = originalUserPepper;
      }
    }
  });
});

test('POST /messaging/v4/identity moves old-key pending messages into rekey-required when the recipient rotates keys', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  const originalUserPepper = process.env.USER_DATA_PEPPER;
  const originalBindingKey = process.env.MESSAGING_BINDING_ENCRYPTION_KEY;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-identity-rotation-test-pepper';
  process.env.USER_DATA_PEPPER = 'messaging-v4-identity-rotation-user-pepper';
  process.env.MESSAGING_BINDING_ENCRYPTION_KEY = '55'.repeat(32);

  const walletPubkey = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const oldMessagingPubkey = '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const newMessagingPubkey = '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const lightningAddressHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const accountId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439071');
  const oldBindingId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439072');
  const newBindingId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439073');
  const account = {
    _id: accountId,
    activeBindingId: oldBindingId,
    ...buildMessagingAccountHmacs({
      walletPubkey,
      lightningAddressHash,
    }),
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
  };
  const oldBinding = {
    _id: oldBindingId,
    active: true,
    messagingAccountId: accountId,
    walletPubkey,
    lightningAddressHash,
    lightningAddressHashScheme: LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
    messagingPubkey: oldMessagingPubkey,
    messagingIdentitySignature: 'old-signature',
    messagingIdentitySignatureVersion: 4,
    messagingIdentitySignedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const directMessageFindCalls = [];
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];
  const bindingUpdateCalls = [];
  const bindingCreateCalls = [];
  const deviceDeleteCalls = [];

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult({
        _id: accountId,
        walletPubkeyUserHmac: userDataHmac(walletPubkey),
      }),
    },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
    { target: MessagingAccount, key: 'findOne', value: async () => account },
    { target: MessagingBinding, key: 'findById', value: async () => oldBinding },
    {
      target: MessagingBinding,
      key: 'updateMany',
      value: async (filter, update) => {
        bindingUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessagingBinding,
      key: 'create',
      value: async (payload) => {
        bindingCreateCalls.push(payload);
        return {
          _id: newBindingId,
          active: true,
          ...payload,
        };
      },
    },
    {
      target: DirectMessageV4,
      key: 'find',
      value: (filter) => {
        directMessageFindCalls.push(filter);
        return queryResult([
          {
            _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439074'),
            senderMessagingAccountId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439075'),
            recipientMessagingAccountId: accountId,
          },
        ]);
      },
    },
    {
      target: DirectMessageV4,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessageAttachmentV4,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessagingDeviceRegistrationV4,
      key: 'deleteMany',
      value: async (filter) => {
        deviceDeleteCalls.push(filter);
        return { deletedCount: 1 };
      },
    },
  ], async () => {
    try {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/messaging/v4/identity`, {
          method: 'POST',
          headers: {
            Cookie: authCookie(String(accountId)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            walletPubkey,
            lightningAddressHash: oldBinding.lightningAddressHash,
            lightningAddressHashScheme: LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
            messagingPubkey: newMessagingPubkey,
            messagingIdentitySignature: 'new-signature',
            messagingIdentitySignatureVersion: 4,
            messagingIdentitySignedAt: 1_712_000_123,
          }),
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.didUpdate, true);
        assert.equal(body.didRotate, true);
        assert.equal(body.binding.walletPubkey, walletPubkey);
        assert.equal(body.binding.lightningAddressHash, oldBinding.lightningAddressHash);
        assert.equal(body.binding.messagingPubkey, newMessagingPubkey);
        assert.equal(account.saveCalls, 1);
        assert.equal(String(account.activeBindingId), String(newBindingId));
        assert.equal(bindingCreateCalls.length, 1);
        assert.notEqual(bindingCreateCalls[0].walletPubkey, walletPubkey);
        assert.notEqual(bindingCreateCalls[0].lightningAddressHash, oldBinding.lightningAddressHash);
        assert.notEqual(bindingCreateCalls[0].messagingPubkey, newMessagingPubkey);
        assert.notEqual(bindingCreateCalls[0].messagingIdentitySignature, 'new-signature');
        assert.ok(bindingCreateCalls[0].bindingPayloadCiphertext);
        assert.ok(bindingCreateCalls[0].bindingPayloadIv);
        assert.ok(bindingCreateCalls[0].bindingPayloadAuthTag);
        assert.equal(bindingUpdateCalls.length, 1);
        assert.deepEqual(bindingUpdateCalls[0].filter, {
          messagingAccountId: accountId,
          active: true,
        });
        assert.equal(bindingUpdateCalls[0].update.$set.active, false);
        assert.equal(directMessageFindCalls.length, 1);
        assert.equal(String(directMessageFindCalls[0].recipientMessagingAccountId), String(accountId));
        assert.deepEqual(directMessageFindCalls[0].recipientMessagingPubkey.$in, [
          oldMessagingPubkey,
        ]);
        assert.equal(directMessageFindCalls[0].status, 'pending');
        assert.equal(directMessageUpdateCalls.length, 1);
        assert.equal(directMessageUpdateCalls[0].update.$set.status, 'rekey_required');
        assert.ok(directMessageUpdateCalls[0].update.$set.rekeyRequiredAt instanceof Date);
        assert.equal(attachmentUpdateCalls.length, 1);
        assert.equal(String(attachmentUpdateCalls[0].filter.recipientMessagingAccountId), String(accountId));
        assert.equal(attachmentUpdateCalls[0].filter.status, 'linked');
        assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
        assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
        assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
        assert.equal(deviceDeleteCalls.length, 1);
        assert.equal(String(deviceDeleteCalls[0].messagingAccountId), String(accountId));
        assert.deepEqual(deviceDeleteCalls[0].messagingPubkeyHmac, {
          $ne: buildMessagingPubkeyHmac(newMessagingPubkey),
        });
      });
    } finally {
      if (originalPepper == null) {
        delete process.env.MESSAGING_DATA_PEPPER;
      } else {
        process.env.MESSAGING_DATA_PEPPER = originalPepper;
      }

      if (originalUserPepper == null) {
        delete process.env.USER_DATA_PEPPER;
      } else {
        process.env.USER_DATA_PEPPER = originalUserPepper;
      }

      if (originalBindingKey == null) {
        delete process.env.MESSAGING_BINDING_ENCRYPTION_KEY;
      } else {
        process.env.MESSAGING_BINDING_ENCRYPTION_KEY = originalBindingKey;
      }
    }
  });
});

test('POST /messaging/v4/rekey-required marks v4 messages and reopens linked attachments for resend', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  const originalUserPepper = process.env.USER_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-rekey-required-test-pepper';
  process.env.USER_DATA_PEPPER = 'messaging-v4-rekey-required-user-pepper';

  const walletPubkey = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const accountId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439041');
  const bindingId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439042');
  const activeBinding = {
    _id: bindingId,
    active: true,
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const messageIds = [
    '507f1f77bcf86cd799439043',
    '507f1f77bcf86cd799439044',
  ];
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult({
        _id: accountId,
        walletPubkeyUserHmac: userDataHmac(walletPubkey),
      }),
    },
    {
      target: MessagingAccount,
      key: 'findOne',
      value: async () => ({
        _id: accountId,
        activeBindingId: bindingId,
      }),
    },
    {
      target: MessagingAccount,
      key: 'find',
      value: () => querySelectLeanResult([
        { _id: accountId, activeBindingId: bindingId },
      ]),
    },
    { target: MessagingBinding, key: 'findById', value: async () => activeBinding },
    {
      target: DirectMessageV4,
      key: 'find',
      value: () => queryResult(messageIds.map((_id) => ({
        _id,
        senderMessagingAccountId: accountId,
        recipientMessagingAccountId: accountId,
      }))),
    },
    {
      target: DirectMessageV4,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 2 };
      },
    },
    {
      target: MessageAttachmentV4,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    try {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/messaging/v4/rekey-required`, {
          method: 'POST',
          headers: {
            Cookie: authCookie(String(accountId)),
            'Content-Type': 'application/json',
            'X-Split-Wallet-Pubkey': walletPubkey,
          },
          body: JSON.stringify({ messageIds }),
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.updatedCount, 2);
        assert.equal(body.resetAttachmentCount, 1);
        assert.equal(directMessageUpdateCalls.length, 1);
        assert.equal(directMessageUpdateCalls[0].update.$set.status, 'rekey_required');
        assert.ok(directMessageUpdateCalls[0].update.$set.rekeyRequiredAt instanceof Date);
        assert.equal(attachmentUpdateCalls.length, 1);
        assert.equal(String(attachmentUpdateCalls[0].filter.recipientMessagingAccountId), String(accountId));
        assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
        assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
        assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
      });
    } finally {
      if (originalPepper == null) {
        delete process.env.MESSAGING_DATA_PEPPER;
      } else {
        process.env.MESSAGING_DATA_PEPPER = originalPepper;
      }

      if (originalUserPepper == null) {
        delete process.env.USER_DATA_PEPPER;
      } else {
        process.env.USER_DATA_PEPPER = originalUserPepper;
      }
    }
  });
});

test('POST /messaging/v4/decrypt-failed handles retry and terminal failure behavior', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  const originalUserPepper = process.env.USER_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-decrypt-failed-test-pepper';
  process.env.USER_DATA_PEPPER = 'messaging-v4-decrypt-failed-user-pepper';

  const walletPubkey = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const accountId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439051');
  const bindingId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439052');
  const activeBinding = {
    _id: bindingId,
    active: true,
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];
  const retryRequiredId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439053');
  const failedId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439054');

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult({
        _id: accountId,
        walletPubkeyUserHmac: userDataHmac(walletPubkey),
      }),
    },
    {
      target: MessagingAccount,
      key: 'findOne',
      value: async () => ({
        _id: accountId,
        activeBindingId: bindingId,
      }),
    },
    {
      target: MessagingAccount,
      key: 'find',
      value: () => querySelectLeanResult([
        { _id: accountId, activeBindingId: bindingId },
      ]),
    },
    { target: MessagingBinding, key: 'findById', value: async () => activeBinding },
    {
      target: DirectMessageV4,
      key: 'find',
      value: () => queryResult([
        {
          _id: retryRequiredId,
          senderMessagingAccountId: accountId,
          recipientMessagingAccountId: accountId,
          sameKeyRetryCount: 0,
        },
        {
          _id: failedId,
          senderMessagingAccountId: accountId,
          recipientMessagingAccountId: accountId,
          sameKeyRetryCount: 1,
        },
      ]),
    },
    {
      target: DirectMessageV4,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessageAttachmentV4,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    try {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/messaging/v4/decrypt-failed`, {
          method: 'POST',
          headers: {
            Cookie: authCookie(String(accountId)),
            'Content-Type': 'application/json',
            'X-Split-Wallet-Pubkey': walletPubkey,
          },
          body: JSON.stringify({
            messageIds: [String(retryRequiredId), String(failedId)],
          }),
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.retryRequiredCount, 1);
        assert.equal(body.failedCount, 1);
        assert.equal(body.resetAttachmentCount, 1);
        assert.equal(directMessageUpdateCalls.length, 2);
        assert.equal(directMessageUpdateCalls[0].update.$set.status, 'same_key_retry_required');
        assert.equal(directMessageUpdateCalls[0].update.$set.sameKeyRetryCount, 1);
        assert.ok(directMessageUpdateCalls[0].update.$set.sameKeyDecryptFailedAt instanceof Date);
        assert.equal(directMessageUpdateCalls[1].update.$set.status, 'failed_same_key');
        assert.ok(directMessageUpdateCalls[1].update.$set.failedAt instanceof Date);
        assert.equal(attachmentUpdateCalls.length, 1);
        assert.equal(String(attachmentUpdateCalls[0].filter.recipientMessagingAccountId), String(accountId));
        assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
        assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
        assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
      });
    } finally {
      if (originalPepper == null) {
        delete process.env.MESSAGING_DATA_PEPPER;
      } else {
        process.env.MESSAGING_DATA_PEPPER = originalPepper;
      }

      if (originalUserPepper == null) {
        delete process.env.USER_DATA_PEPPER;
      } else {
        process.env.USER_DATA_PEPPER = originalUserPepper;
      }
    }
  });
});

test('GET /messaging/v4/outgoing-statuses prioritizes actionable statuses by messaging account', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  const originalUserPepper = process.env.USER_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-outgoing-status-test-pepper';
  process.env.USER_DATA_PEPPER = 'messaging-v4-outgoing-status-user-pepper';

  const walletPubkey = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const accountId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439061');
  const bindingId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439062');
  const activeBinding = {
    _id: bindingId,
    active: true,
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const findCalls = [];
  const actionableMessages = [
    {
      _id: 'msg-v4-undelivered-1',
      senderMessagingAccountId: accountId,
      recipientMessagingAccountId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439063'),
      clientMessageId: 'client-v4-undelivered-1',
      status: 'undelivered',
      sameKeyRetryCount: 0,
      createdAt: new Date('2026-04-01T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T12:00:00.000Z'),
      expiredAt: new Date('2026-04-15T12:00:00.000Z'),
    },
    {
      _id: 'msg-v4-rekey-1',
      senderMessagingAccountId: accountId,
      recipientMessagingAccountId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439064'),
      clientMessageId: 'client-v4-rekey-1',
      status: 'rekey_required',
      sameKeyRetryCount: 0,
      createdAt: new Date('2026-03-25T09:00:00.000Z'),
      updatedAt: new Date('2026-04-14T08:30:00.000Z'),
      rekeyRequiredAt: new Date('2026-04-14T08:30:00.000Z'),
    },
  ];
  const recentMessages = [
    {
      _id: 'msg-v4-delivered-1',
      senderMessagingAccountId: accountId,
      recipientMessagingAccountId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439065'),
      clientMessageId: 'client-v4-delivered-1',
      status: 'delivered',
      createdAt: new Date('2026-04-16T15:00:00.000Z'),
      updatedAt: new Date('2026-04-16T15:01:00.000Z'),
      deliveredAt: new Date('2026-04-16T15:01:00.000Z'),
    },
  ];

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult({
        _id: accountId,
        walletPubkeyUserHmac: userDataHmac(walletPubkey),
      }),
    },
    {
      target: MessagingAccount,
      key: 'findOne',
      value: async () => ({
        _id: accountId,
        activeBindingId: bindingId,
      }),
    },
    { target: MessagingBinding, key: 'findById', value: async () => activeBinding },
    {
      target: DirectMessageV4,
      key: 'find',
      value: (filter) => {
        const call = { filter, sort: null, limit: null };
        findCalls.push(call);

        const resultSet = filter?.status?.$in
          ? actionableMessages
          : recentMessages;

        return {
          sort(sortSpec) {
            call.sort = sortSpec;
            return this;
          },
          limit(limitValue) {
            call.limit = limitValue;
            return this;
          },
          lean: async () => resultSet,
        };
      },
    },
  ], async () => {
    try {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/messaging/v4/outgoing-statuses?limit=3`, {
          headers: {
            Cookie: authCookie(String(accountId)),
            'X-Split-Wallet-Pubkey': walletPubkey,
          },
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(findCalls.length, 2);
        assert.deepEqual(findCalls[0].filter, {
          senderMessagingAccountId: accountId,
          status: { $in: ['rekey_required', 'same_key_retry_required', 'failed_same_key', 'undelivered'] },
        });
        assert.deepEqual(findCalls[0].sort, { updatedAt: -1, createdAt: -1 });
        assert.equal(findCalls[0].limit, 3);
        assert.deepEqual(findCalls[1].filter, {
          senderMessagingAccountId: accountId,
          status: { $nin: ['rekey_required', 'same_key_retry_required', 'failed_same_key', 'undelivered'] },
        });
        assert.deepEqual(findCalls[1].sort, { createdAt: -1 });
        assert.equal(findCalls[1].limit, 1);
        assert.deepEqual(
          body.messages.map((message) => message.messageId),
          ['msg-v4-undelivered-1', 'msg-v4-rekey-1', 'msg-v4-delivered-1']
        );
        assert.deepEqual(
          body.messages.map((message) => message.status),
          ['undelivered', 'rekey_required', 'delivered']
        );
      });
    } finally {
      if (originalPepper == null) {
        delete process.env.MESSAGING_DATA_PEPPER;
      } else {
        process.env.MESSAGING_DATA_PEPPER = originalPepper;
      }

      if (originalUserPepper == null) {
        delete process.env.USER_DATA_PEPPER;
      } else {
        process.env.USER_DATA_PEPPER = originalUserPepper;
      }
    }
  });
});
