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
const UserBlock = require('../models/UserBlock');
const UserBlockV4 = require('../models/UserBlockV4');
const DirectMessage = require('../models/DirectMessage');
const DirectMessageV4 = require('../models/DirectMessageV4');
const MessageAttachment = require('../models/MessageAttachment');
const MessageAttachmentV4 = require('../models/MessageAttachmentV4');
const MessagingAccount = require('../models/MessagingAccount');
const MessagingBinding = require('../models/MessagingBinding');
const MessagingDeviceRegistration = require('../models/MessagingDeviceRegistration');
const MessagingDeviceRegistrationV4 = require('../models/MessagingDeviceRegistrationV4');
const MessagingBindingLog = require('../models/MessagingBindingLog');
const MessagingDirectoryState = require('../models/MessagingDirectoryState');
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
  USER_HMAC_VERSION,
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
    lightningAddress: null,
    messagingPubkeyV2: null,
    messagingIdentityV2Signature: null,
    messagingIdentityV2SignatureVersion: null,
    messagingIdentityV2SignedAt: null,
    messagingIdentityV2UpdatedAt: null,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides,
  };
}

function querySortSelectAwaitableResult(value) {
  return {
    sort() {
      return this;
    },
    select: async () => value,
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function createDirectoryModelPatches({ entryCreatedAt = new Date('2026-01-03T00:00:00.000Z') } = {}) {
  const bindingLogEntries = [];
  let directoryStateUpdateCalls = 0;

  return [
    {
      target: MessagingBindingLog,
      key: 'findOne',
      value: () => querySortSelectAwaitableResult(
        bindingLogEntries.length
          ? bindingLogEntries[bindingLogEntries.length - 1]
          : null
      ),
    },
    {
      target: MessagingBindingLog,
      key: 'create',
      value: async (payload) => {
        const entry = {
          _id: `binding-log-${bindingLogEntries.length + 1}`,
          createdAt: entryCreatedAt,
          ...payload,
        };
        bindingLogEntries.push(entry);
        return entry;
      },
    },
    {
      target: MessagingBindingLog,
      key: 'find',
      value: () => querySortSelectAwaitableResult(bindingLogEntries),
    },
    {
      target: MessagingDirectoryState,
      key: 'findOneAndUpdate',
      value: async () => {
        directoryStateUpdateCalls += 1;
        if (directoryStateUpdateCalls === 2) {
          return { lastLeafIndex: bindingLogEntries.length };
        }

        return {};
      },
    },
  ];
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

test('POST /lightning-address saves a normalized address for a user who does not have one yet', async (t) => {
  const user = buildUser();

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/lightning-address`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: '  Donate@Example.Invalid ',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.lightningAddress, 'donate@example.invalid');
      assert.equal(user.lightningAddress, 'donate@example.invalid');
      assert.equal(user.saveCalls, 1);
    });
  });
});

test('POST /lightning-address dual-writes the user-domain Lightning address HMAC', async (t) => {
  const originalPepper = process.env.USER_DATA_PEPPER;
  process.env.USER_DATA_PEPPER = 'route-lightning-address-hmac-test-pepper';
  const user = buildUser();

  try {
    await withPatchedMethods([
      { target: User, key: 'findById', value: () => queryResult(user) },
    ], async () => {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/lightning-address`, {
          method: 'POST',
          headers: {
            Cookie: authCookie(String(user._id)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            lightningAddress: ' Donate@Example.Invalid ',
          }),
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.didUpdate, true);
        assert.equal(user.lightningAddressUserHmac, userDataHmac(
          'donate@example.invalid',
          { pepper: process.env.USER_DATA_PEPPER }
        ));
        assert.equal(user.lightningAddressUserHmacVersion, USER_HMAC_VERSION);
        assert.equal(user.saveCalls, 1);
      });
    });
  } finally {
    if (originalPepper) {
      process.env.USER_DATA_PEPPER = originalPepper;
    } else {
      delete process.env.USER_DATA_PEPPER;
    }
  }
});

test('POST /lightning-address is a no-op when the user already has one', async (t) => {
  const originalPepper = process.env.USER_DATA_PEPPER;
  delete process.env.USER_DATA_PEPPER;
  const user = buildUser({
    lightningAddress: 'donate@example.invalid',
  });

  try {
    await withPatchedMethods([
      { target: User, key: 'findById', value: () => queryResult(user) },
    ], async () => {
      await maybeWithServer(t, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/lightning-address`, {
          method: 'POST',
          headers: {
            Cookie: authCookie(String(user._id)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            lightningAddress: 'other@example.invalid',
          }),
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.didUpdate, false);
        assert.equal(body.lightningAddress, 'donate@example.invalid');
        assert.equal(user.saveCalls, 0);
      });
    });
  } finally {
    if (originalPepper) {
      process.env.USER_DATA_PEPPER = originalPepper;
    }
  }
});

test('POST /v1/account/delete deletes the authenticated user and owned account data', async (t) => {
  const originalMessagingPepper = process.env.MESSAGING_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'account-delete-v4-test-pepper';

  const user = buildUser({
    _id: new mongoose.Types.ObjectId(),
    profilePicUrl: 'https://cdn.example.invalid/profile-pictures/user-1.png',
    async deleteOne() {
      this.didDelete = true;
      return { deletedCount: 1 };
    },
  });
  const messagingAccountId = new mongoose.Types.ObjectId();
  const attachmentId = new mongoose.Types.ObjectId();
  const deletedDeviceRegistrationFilters = [];
  const deletedBlockFilters = [];
  const messagingAccountFindFilters = [];
  const v4AttachmentFindFilters = [];
  const v4AttachmentDeleteFilters = [];
  const v4DirectMessageDeleteFilters = [];
  const v4BlockDeleteFilters = [];
  const v4DeviceRegistrationDeleteFilters = [];
  const v4BindingDeleteFilters = [];
  const v4AccountDeleteFilters = [];
  const r2DeleteCommands = [];

  try {
    await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: MessagingDeviceRegistration,
      key: 'deleteMany',
      value: async (filter) => {
        deletedDeviceRegistrationFilters.push(filter);
        return { deletedCount: 2 };
      },
    },
    {
      target: UserBlock,
      key: 'deleteMany',
      value: async (filter) => {
        deletedBlockFilters.push(filter);
        return { deletedCount: 3 };
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
    {
      target: MessageAttachmentV4,
      key: 'find',
      value: (filter) => {
        v4AttachmentFindFilters.push(filter);
        return queryResult([
          {
            _id: attachmentId,
            objectKey: 'messaging/v4/attachments/account-attachment.bin',
          },
        ]);
      },
    },
    {
      target: MessageAttachmentV4,
      key: 'deleteMany',
      value: async (filter) => {
        v4AttachmentDeleteFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
    {
      target: DirectMessageV4,
      key: 'deleteMany',
      value: async (filter) => {
        v4DirectMessageDeleteFilters.push(filter);
        return { deletedCount: 4 };
      },
    },
    {
      target: UserBlockV4,
      key: 'deleteMany',
      value: async (filter) => {
        v4BlockDeleteFilters.push(filter);
        return { deletedCount: 5 };
      },
    },
    {
      target: MessagingDeviceRegistrationV4,
      key: 'deleteMany',
      value: async (filter) => {
        v4DeviceRegistrationDeleteFilters.push(filter);
        return { deletedCount: 6 };
      },
    },
    {
      target: MessagingBinding,
      key: 'deleteMany',
      value: async (filter) => {
        v4BindingDeleteFilters.push(filter);
        return { deletedCount: 7 };
      },
    },
    {
      target: MessagingAccount,
      key: 'deleteOne',
      value: async (filter) => {
        v4AccountDeleteFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
    {
      target: s3Client,
      key: 'send',
      value: async (command) => {
        r2DeleteCommands.push(command);
        return {};
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/account/delete`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id), user.walletPubkey),
        },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(user.didDelete, true);
      assert.deepEqual(deletedDeviceRegistrationFilters, [{ userId: user._id }]);
      assert.deepEqual(deletedBlockFilters, [{ blockerUserId: user._id }]);
      assert.deepEqual(messagingAccountFindFilters, [{
        walletPubkeyMessagingHmac: messagingDataHmac(user.walletPubkey),
      }]);
      assert.deepEqual(v4AttachmentFindFilters, [{
        $or: [
          { senderMessagingAccountId: messagingAccountId },
          { recipientMessagingAccountId: messagingAccountId },
        ],
      }]);
      assert.deepEqual(v4AttachmentDeleteFilters, [{ _id: { $in: [attachmentId] } }]);
      assert.deepEqual(v4DirectMessageDeleteFilters, [{
        $or: [
          { senderMessagingAccountId: messagingAccountId },
          { recipientMessagingAccountId: messagingAccountId },
        ],
      }]);
      assert.deepEqual(v4BlockDeleteFilters, [{
        $or: [
          { blockerMessagingAccountId: messagingAccountId },
          { blockedMessagingAccountId: messagingAccountId },
        ],
      }]);
      assert.deepEqual(v4DeviceRegistrationDeleteFilters, [{ messagingAccountId }]);
      assert.deepEqual(v4BindingDeleteFilters, [{ messagingAccountId }]);
      assert.deepEqual(v4AccountDeleteFilters, [{ _id: messagingAccountId }]);
      assert.deepEqual(
        r2DeleteCommands.map((command) => command.input.Key).sort(),
        [
          'messaging/v4/attachments/account-attachment.bin',
          'profile-pictures/user-1.png',
        ]
      );
      assert.equal(body.deleted.deviceRegistrations, 2);
      assert.equal(body.deleted.userBlocks, 3);
      assert.equal(body.deleted.v4MessagingAccount, 1);
      assert.equal(body.deleted.v4MessagingBindings, 7);
      assert.equal(body.deleted.v4DeviceRegistrations, 6);
      assert.equal(body.deleted.v4UserBlocks, 5);
      assert.equal(body.deleted.v4DirectMessages, 4);
      assert.equal(body.deleted.v4Attachments, 1);
      assert.equal(body.deleted.v4AttachmentObjectsDeleted, 1);
    });
  });
  } finally {
    if (originalMessagingPepper) {
      process.env.MESSAGING_DATA_PEPPER = originalMessagingPepper;
    } else {
      delete process.env.MESSAGING_DATA_PEPPER;
    }
  }
});

test('POST /v1/account/delete requires an authenticated session', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/account/delete`, {
      method: 'POST',
    });

    assert.equal(response.status, 401);
  });
});

test('GET /rewards-version-check returns the enforced minimum version by default', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, getRewardsMinimumVersion());
  });
});

test('GET /rewards-version-check returns the enforced iOS minimum version when platform=ios', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check?platform=ios`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, getRewardsMinimumVersion('ios'));
  });
});

test('GET /rewards-version-check returns the enforced Android minimum version when platform=android', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check?platform=android`);
    const body = await response.json();

    assert.equal(response.status, 200);
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

test('POST /RewardsCheck returns reward eligibility for known merchant pubkeys', async (t) => {
  const user = buildUser({ _id: 'reward-check-user-1' });
  const merchantQueries = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: MerchantPubKey,
      key: 'findOne',
      value: (query) => {
        merchantQueries.push(query);
        return querySelectLeanResult({ _id: 'merchant-pubkey-1' });
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/RewardsCheck`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          destinationPubkey: ' 03merchantpubkey ',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.rewardEligible, true);
      assert.equal(body.merchantMatched, true);
      assert.deepEqual(merchantQueries, [{
        pubkey: {
          $regex: '^03merchantpubkey$',
          $options: 'i',
        },
      }]);
    });
  });
});

test('POST /RewardsCheck returns ineligible for unknown merchant pubkeys', async (t) => {
  const user = buildUser({ _id: 'reward-check-user-2' });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: MerchantPubKey,
      key: 'findOne',
      value: () => querySelectLeanResult(null),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/RewardsCheck`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          destinationPubkey: '03unknownpubkey',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.rewardEligible, false);
      assert.equal(body.merchantMatched, false);
    });
  });
});

test('POST /RewardsCheck validates destinationPubkey', async (t) => {
  const user = buildUser({ _id: 'reward-check-user-3' });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/RewardsCheck`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          destinationPubkey: '   ',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'destinationPubkey is required');
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

test('POST /messaging/v3/identity rejects an invalid wallet signature', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
  });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => false },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/identity`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          lightningAddress: user.lightningAddress,
          messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          messagingIdentitySignature: 'deadbeef',
          messagingIdentitySignatureVersion: 2,
          messagingIdentitySignedAt: 1_712_000_000,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 401);
      assert.equal(body.error, 'Invalid messaging v2 identity signature');
    });
  });
});

test('POST /messaging/v3/identity stores the current messaging identity when the signature is valid', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
  });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
    { target: MessagingDeviceRegistration, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
    ...createDirectoryModelPatches(),
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/identity`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          lightningAddress: user.lightningAddress,
          messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          messagingIdentitySignature: 'deadbeef',
          messagingIdentitySignatureVersion: 2,
          messagingIdentitySignedAt: 1_712_000_000,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.didRotate, false);
      assert.equal(user.messagingPubkeyV2, '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      assert.equal(user.messagingIdentityV2Signature, 'deadbeef');
      assert.equal(user.messagingIdentityV2SignatureVersion, 2);
      assert.equal(Math.floor(user.messagingIdentityV2SignedAt.getTime() / 1000), 1_712_000_000);
      assert.ok(body.directory);
      assert.equal(user.saveCalls, 1);
    });
  });
});

test('POST /messaging/v3/identity moves old-key pending messages into rekey-required when the recipient rotates keys', async (t) => {
  const oldMessagingPubkey = '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const newMessagingPubkey = '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: oldMessagingPubkey,
    messagingIdentityV2Signature: 'old-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const directMessageFindCalls = [];
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
    { target: MessagingDeviceRegistration, key: 'deleteMany', value: async () => ({ deletedCount: 0 }) },
    {
      target: DirectMessage,
      key: 'find',
      value: (filter) => {
        directMessageFindCalls.push(filter);
        return queryResult([
          {
            _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439041'),
            senderUserId: 'sender-1',
            recipientWalletPubkey: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          },
        ]);
      },
    },
    {
      target: DirectMessage,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessageAttachment,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    ...createDirectoryModelPatches(),
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/identity`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          lightningAddress: user.lightningAddress,
          messagingPubkey: newMessagingPubkey,
          messagingIdentitySignature: 'new-signature',
          messagingIdentitySignatureVersion: 2,
          messagingIdentitySignedAt: 1_712_000_123,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.didRotate, true);
      assert.equal(user.messagingPubkeyV2, newMessagingPubkey);
      assert.equal(directMessageFindCalls.length, 1);
      assert.equal(directMessageFindCalls[0].recipientUserId, user._id);
      assert.deepEqual(directMessageFindCalls[0].recipientMessagingPubkey.$in, [
        oldMessagingPubkey,
      ]);
      assert.equal(directMessageFindCalls[0].status, 'pending');
      assert.equal(directMessageUpdateCalls.length, 1);
      assert.equal(directMessageUpdateCalls[0].update.$set.status, 'rekey_required');
      assert.ok(directMessageUpdateCalls[0].update.$set.rekeyRequiredAt instanceof Date);
      assert.equal(attachmentUpdateCalls.length, 1);
      assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
      assert.equal(user.saveCalls, 1);
    });
  });
});

test('POST /messaging/v4/identity moves old-key pending messages into rekey-required when the recipient rotates keys', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-identity-rotation-test-pepper';

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
  const deviceDeleteCalls = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(null) },
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
      value: async (payload) => ({
        _id: newBindingId,
        active: true,
        ...payload,
      }),
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
            Cookie: authCookie(String(accountId), walletPubkey),
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
        assert.equal(account.saveCalls, 1);
        assert.equal(String(account.activeBindingId), String(newBindingId));
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
    }
  });
});

test('POST /messaging/v3/directory/lookup returns the signed recipient bundle when both sides are active', async (t) => {
  const sender = buildUser({
    _id: 'sender-1',
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const recipient = buildUser({
    _id: 'recipient-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'bob@example.invalid',
    messagingPubkeyV2: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    messagingIdentityV2Signature: 'recipient-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-02T00:00:00.000Z'),
    profilePicUrl: 'https://cdn.example.invalid/bob.png',
  });

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: (id) => queryResult(String(id) === String(sender._id) ? sender : null),
    },
    {
      target: User,
      key: 'findOne',
      value: ({ lightningAddress }) => queryResult(
        lightningAddress === recipient.lightningAddress ? recipient : null
      ),
    },
    ...createDirectoryModelPatches(),
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/directory/lookup`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(sender._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: recipient.lightningAddress,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.recipient.walletPubkey, recipient.walletPubkey);
      assert.equal(body.recipient.lightningAddress, recipient.lightningAddress);
      assert.equal(body.recipient.messagingPubkey, recipient.messagingPubkeyV2);
      assert.equal(body.recipient.profilePicUrl, recipient.profilePicUrl);
      assert.ok(body.directory);
    });
  });
});

test('POST /messaging/blocks creates a block by lightningAddress and clears pending relay messages', async (t) => {
  const blocker = buildUser({
    _id: 'blocker-1',
    lightningAddress: 'alice@example.invalid',
  });
  const target = buildUser({
    _id: 'blocked-1',
    walletPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lightningAddress: 'bob@example.invalid',
    profilePicUrl: 'https://cdn.example.invalid/bob.png',
  });
  const deletedMessageFilters = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(blocker) },
    {
      target: User,
      key: 'findOne',
      value: ({ lightningAddress, walletPubkey }) => queryResult(
        lightningAddress === target.lightningAddress || walletPubkey === target.walletPubkey
          ? target
          : null
      ),
    },
    { target: UserBlock, key: 'findOne', value: () => null },
    {
      target: UserBlock,
      key: 'create',
      value: async (payload) => ({
        _id: 'block-1',
        createdAt: new Date('2026-04-08T12:00:00.000Z'),
        updatedAt: new Date('2026-04-08T12:00:00.000Z'),
        ...payload,
      }),
    },
    {
      target: DirectMessage,
      key: 'find',
      value: () => queryResult([{ _id: 'msg-1' }]),
    },
    {
      target: DirectMessage,
      key: 'deleteMany',
      value: async (filter) => {
        deletedMessageFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
    {
      target: MessageAttachment,
      key: 'find',
      value: () => queryResult([]),
    },
    {
      target: MessageAttachment,
      key: 'deleteMany',
      value: async () => ({ deletedCount: 0 }),
    },
    {
      target: s3Client,
      key: 'send',
      value: async () => ({}),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/blocks`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(blocker._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: target.lightningAddress,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.block.blockedWalletPubkey, target.walletPubkey);
      assert.equal(body.block.blockedLightningAddress, target.lightningAddress);
      assert.equal(body.block.blockedProfilePicUrl, target.profilePicUrl);
      assert.equal(deletedMessageFilters.length, 1);
      assert.equal(deletedMessageFilters[0].status, 'pending');
      assert.equal(deletedMessageFilters[0]._id.$in.length, 1);
    });
  });
});

test('GET /messaging/blocks returns the authenticated users block list', async (t) => {
  const blocker = buildUser({
    _id: 'blocker-1',
  });
  const storedBlocks = [
    {
      _id: 'block-1',
      blockerUserId: blocker._id,
      blockedUserId: 'blocked-1',
      blockedWalletPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      blockedLightningAddress: 'bob@example.invalid',
      blockedProfilePicUrl: 'https://cdn.example.invalid/bob.png',
      createdAt: new Date('2026-04-08T12:00:00.000Z'),
      updatedAt: new Date('2026-04-08T12:00:00.000Z'),
    },
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(blocker) },
    { target: UserBlock, key: 'find', value: () => queryChainResult(storedBlocks) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/blocks`, {
        headers: {
          Cookie: authCookie(String(blocker._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.blocks.length, 1);
      assert.equal(body.blocks[0].blockedWalletPubkey, storedBlocks[0].blockedWalletPubkey);
      assert.equal(body.blocks[0].blockedLightningAddress, storedBlocks[0].blockedLightningAddress);
    });
  });
});

test('DELETE /messaging/blocks/:blockedWalletPubkey removes a block idempotently', async (t) => {
  const blocker = buildUser({
    _id: 'blocker-1',
  });
  const deleteFilters = [];
  const blockedWalletPubkey = '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(blocker) },
    {
      target: UserBlock,
      key: 'deleteOne',
      value: async (filter) => {
        deleteFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/blocks/${blockedWalletPubkey}`, {
        method: 'DELETE',
        headers: {
          Cookie: authCookie(String(blocker._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didDelete, true);
      assert.equal(body.blockedWalletPubkey, blockedWalletPubkey);
      assert.equal(deleteFilters.length, 1);
      assert.equal(deleteFilters[0].blockerUserId, blocker._id);
      assert.equal(deleteFilters[0].blockedWalletPubkey, blockedWalletPubkey);
    });
  });
});

test('POST /messaging/v3/directory/lookup returns a generic unavailable error when the recipient blocked the sender', async (t) => {
  const sender = buildUser({
    _id: 'sender-1',
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const recipient = buildUser({
    _id: 'recipient-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'bob@example.invalid',
    messagingPubkeyV2: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    messagingIdentityV2Signature: 'recipient-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult(sender),
    },
    {
      target: User,
      key: 'findOne',
      value: ({ lightningAddress }) => queryResult(
        lightningAddress === recipient.lightningAddress ? recipient : null
      ),
    },
    {
      target: UserBlock,
      key: 'findOne',
      value: ({ blockerUserId, blockedUserId }) => queryResult(
        String(blockerUserId) === String(recipient._id) &&
          String(blockedUserId) === String(sender._id)
          ? { _id: 'block-1' }
          : null
      ),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/directory/lookup`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(sender._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: recipient.lightningAddress,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.error, 'Recipient is unavailable');
    });
  });
});

test('POST /messaging/v3/send rejects sends to a user the sender has blocked', async (t) => {
  const sender = buildUser({
    _id: 'sender-1',
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const recipient = buildUser({
    _id: 'recipient-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'bob@example.invalid',
    messagingPubkeyV2: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    messagingIdentityV2Signature: 'recipient-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult(sender),
    },
    {
      target: User,
      key: 'findOne',
      value: ({ walletPubkey }) => queryResult(
        walletPubkey === recipient.walletPubkey ? recipient : null
      ),
    },
    {
      target: UserBlock,
      key: 'findOne',
      value: ({ blockerUserId, blockedUserId }) => queryResult(
        String(blockerUserId) === String(sender._id) &&
          String(blockedUserId) === String(recipient._id)
          ? { _id: 'block-1' }
          : null
      ),
    },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/send`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(sender._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientMessageId: 'client-message-1',
          recipient: {
            walletPubkey: recipient.walletPubkey,
            lightningAddress: recipient.lightningAddress,
            messagingPubkey: recipient.messagingPubkeyV2,
            messagingIdentitySignature: recipient.messagingIdentityV2Signature,
            messagingIdentitySignatureVersion: 2,
            messagingIdentitySignedAt: 1_704_153_600,
          },
          ciphertext: 'ciphertext',
          nonce: 'nonce',
          senderEphemeralPubkey: '02eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          createdAtClientMs: 1_712_000_000_000,
          envelopeVersion: 3,
          messageType: 'text',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.error, 'You have blocked this user');
    });
  });
});

test('POST /messaging/v3/device-registrations stores a registration for the active messaging pubkey', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const staleRegistrationFilters = [];
  const storedRegistration = {
    _id: 'registration-1',
    userId: user._id,
    walletPubkey: user.walletPubkey,
    messagingPubkey: user.messagingPubkeyV2,
    deviceToken: 'a'.repeat(64),
    platform: 'apns',
    environment: 'dev',
    registrationSignedAt: new Date('2026-04-10T12:00:00.000Z'),
    appVersion: '3.7.0',
    bundleId: 'com.example.app',
    lastSeenAt: new Date('2026-04-10T12:00:00.000Z'),
    createdAt: new Date('2026-04-10T12:00:00.000Z'),
    updatedAt: new Date('2026-04-10T12:00:00.000Z'),
  };

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
    { target: MessagingDeviceRegistration, key: 'findOne', value: async () => null },
    {
      target: MessagingDeviceRegistration,
      key: 'findOneAndUpdate',
      value: async () => storedRegistration,
    },
    {
      target: MessagingDeviceRegistration,
      key: 'deleteMany',
      value: async (filter) => {
        staleRegistrationFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/device-registrations`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          messagingPubkey: user.messagingPubkeyV2,
          platform: 'apns',
          environment: 'dev',
          deviceToken: 'A'.repeat(64),
          registrationSignature: 'device-registration-signature',
          registrationSignatureVersion: 1,
          registrationSignedAt: 1_712_750_400,
          appVersion: '3.7.0',
          bundleId: 'com.example.app',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.registration.messagingPubkey, user.messagingPubkeyV2);
      assert.equal(body.registration.environment, 'dev');
      assert.equal(body.registration.deviceToken, 'a'.repeat(64));
      assert.equal(staleRegistrationFilters.length, 1);
      assert.equal(staleRegistrationFilters[0].userId, user._id);
      assert.equal(staleRegistrationFilters[0].messagingPubkey.$ne, user.messagingPubkeyV2);
    });
  });
});

test('POST /messaging/v3/ack deletes successfully delivered relay messages', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
    messagingPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const deleteCalls = [];
  const messageIds = [
    '507f1f77bcf86cd799439011',
    '507f1f77bcf86cd799439012',
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
      key: 'deleteMany',
      value: async (filter) => {
        deleteCalls.push(filter);
        return { deletedCount: 2 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/ack`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageIds }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.acknowledgedCount, 2);
      assert.equal(deleteCalls.length, 1);
      assert.deepEqual(deleteCalls[0].recipientMessagingPubkey.$in, [
        user.messagingPubkeyV2,
      ]);
      assert.deepEqual(deleteCalls[0]._id.$in.map(String), messageIds);
      assert.equal(String(deleteCalls[0].recipientUserId), String(user._id));
      assert.equal(deleteCalls[0].status, 'pending');
    });
  });
});

test('POST /messaging/v3/rekey-required marks messages and reopens linked attachments for resend', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const messageIds = [
    '507f1f77bcf86cd799439021',
    '507f1f77bcf86cd799439022',
  ];
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
      key: 'find',
      value: () => queryResult(messageIds.map((_id) => ({ _id }))),
    },
    {
      target: DirectMessage,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 2 };
      },
    },
    {
      target: MessageAttachment,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/rekey-required`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
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
      assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
    });
  });
});

test('POST /messaging/v3/decrypt-failed requests one silent retry, then marks the next attempt terminal', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.invalid',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];
  const retryRequiredId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439031');
  const failedId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439032');

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
      key: 'find',
      value: () => queryResult([
        {
          _id: retryRequiredId,
          senderUserId: 'sender-1',
          recipientWalletPubkey: 'recipient-wallet-1',
          sameKeyRetryCount: 0,
        },
        {
          _id: failedId,
          senderUserId: 'sender-1',
          recipientWalletPubkey: 'recipient-wallet-1',
          sameKeyRetryCount: 1,
        },
      ]),
    },
    {
      target: DirectMessage,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessageAttachment,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/decrypt-failed`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
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
      assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
    });
  });
});

test('POST /messaging/v4/rekey-required marks v4 messages and reopens linked attachments for resend', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-rekey-required-test-pepper';

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
            Cookie: authCookie(String(accountId), walletPubkey),
            'Content-Type': 'application/json',
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
    }
  });
});

test('POST /messaging/v4/decrypt-failed mirrors v3 retry and terminal failure behavior', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-decrypt-failed-test-pepper';

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
            Cookie: authCookie(String(accountId), walletPubkey),
            'Content-Type': 'application/json',
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
    }
  });
});

test('GET /messaging/v3/outgoing-statuses prioritizes actionable statuses ahead of newer normal traffic', async (t) => {
  const user = buildUser({
    _id: 'sender-status-user-1',
  });
  const findCalls = [];
  const actionableMessages = [
    {
      _id: 'msg-undelivered-1',
      clientMessageId: 'client-undelivered-1',
      recipientLightningAddress: 'alice@example.invalid',
      recipientWalletPubkey: 'wallet-undelivered-1',
      status: 'undelivered',
      sameKeyRetryCount: 0,
      createdAt: new Date('2026-04-01T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T12:00:00.000Z'),
      expiredAt: new Date('2026-04-15T12:00:00.000Z'),
    },
    {
      _id: 'msg-rekey-1',
      clientMessageId: 'client-rekey-1',
      recipientLightningAddress: 'bob@example.invalid',
      recipientWalletPubkey: 'wallet-rekey-1',
      status: 'rekey_required',
      sameKeyRetryCount: 0,
      createdAt: new Date('2026-03-25T09:00:00.000Z'),
      updatedAt: new Date('2026-04-14T08:30:00.000Z'),
      rekeyRequiredAt: new Date('2026-04-14T08:30:00.000Z'),
    },
  ];
  const recentMessages = [
    {
      _id: 'msg-delivered-1',
      clientMessageId: 'client-delivered-1',
      status: 'delivered',
      createdAt: new Date('2026-04-16T15:00:00.000Z'),
      updatedAt: new Date('2026-04-16T15:01:00.000Z'),
      deliveredAt: new Date('2026-04-16T15:01:00.000Z'),
    },
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
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
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/outgoing-statuses?limit=3`, {
        headers: {
          Cookie: authCookie(String(user._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(findCalls.length, 2);
      assert.deepEqual(findCalls[0].filter, {
        senderUserId: user._id,
        status: { $in: ['rekey_required', 'same_key_retry_required', 'failed_same_key', 'undelivered'] },
      });
      assert.deepEqual(findCalls[0].sort, { updatedAt: -1, createdAt: -1 });
      assert.equal(findCalls[0].limit, 3);
      assert.deepEqual(findCalls[1].filter, {
        senderUserId: user._id,
        status: { $nin: ['rekey_required', 'same_key_retry_required', 'failed_same_key', 'undelivered'] },
      });
      assert.deepEqual(findCalls[1].sort, { createdAt: -1 });
      assert.equal(findCalls[1].limit, 1);
      assert.deepEqual(
        body.messages.map((message) => message.messageId),
        ['msg-undelivered-1', 'msg-rekey-1', 'msg-delivered-1']
      );
      assert.deepEqual(
        body.messages.map((message) => message.status),
        ['undelivered', 'rekey_required', 'delivered']
      );
    });
  });
});

test('GET /messaging/v4/outgoing-statuses prioritizes actionable statuses by messaging account', async (t) => {
  const originalPepper = process.env.MESSAGING_DATA_PEPPER;
  process.env.MESSAGING_DATA_PEPPER = 'messaging-v4-outgoing-status-test-pepper';

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
            Cookie: authCookie(String(accountId), walletPubkey),
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
    }
  });
});
