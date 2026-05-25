const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expirePendingMessages,
  expirePendingAttachments,
  pruneOldAttachmentReceipts,
  pruneOldReceipts,
} = require('../messaging/messagingRelayCleanup');

function buildQueryReturning(value) {
  return {
    select: async () => value,
  };
}

test('expirePendingAttachments deletes expired attachment blobs and marks records expired', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const saveCalls = [];
  const deleteCommands = [];

  const attachments = [
    {
      _id: 'att-1',
      objectKey: 'messaging-attachments/u1/file-1.bin',
      status: 'uploaded',
      deletedAt: null,
      async save() {
        saveCalls.push({
          id: this._id,
          status: this.status,
          deletedAt: this.deletedAt,
        });
      },
    },
    {
      _id: 'att-2',
      objectKey: 'messaging-attachments/u1/file-2.bin',
      status: 'linked',
      deletedAt: null,
      async save() {
        saveCalls.push({
          id: this._id,
          status: this.status,
          deletedAt: this.deletedAt,
        });
      },
    },
  ];

  const attachmentModel = {
    find(filter) {
      assert.deepEqual(filter, {
        status: { $in: ['uploaded', 'linked'] },
        expiresAt: { $lte: now },
      });
      return buildQueryReturning(attachments);
    },
  };

  const storageClient = {
    async send(command) {
      deleteCommands.push(command.input);
      return {};
    },
  };

  await expirePendingAttachments({
    now,
    attachmentModel,
    storageClient,
    bucket: 'split-test-bucket',
  });

  assert.equal(deleteCommands.length, 2);
  assert.deepEqual(deleteCommands.map((entry) => entry.Key), [
    'messaging-attachments/u1/file-1.bin',
    'messaging-attachments/u1/file-2.bin',
  ]);
  assert.equal(saveCalls.length, 2);
  assert.deepEqual(saveCalls.map((entry) => entry.status), ['expired', 'expired']);
  assert.deepEqual(saveCalls.map((entry) => entry.deletedAt), [now, now]);
});

test('expirePendingMessages marks expired pending rows as undelivered and clears sealed payload fields', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const updateCalls = [];

  const directMessageModel = {
    async updateMany(filter, update) {
      updateCalls.push({ filter, update });
      return { modifiedCount: 2 };
    },
  };

  await expirePendingMessages({
    now,
    directMessageModel,
  });

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].filter, {
    status: 'pending',
    expiresAt: { $lte: now },
  });
  assert.deepEqual(updateCalls[0].update, {
    $set: {
      status: 'undelivered',
      expiredAt: now,
    },
    $unset: {
      ciphertext: '',
      nonce: '',
      senderEphemeralPubkey: '',
    },
  });
});

test('pruneOldReceipts deletes delivered receipts by receipt expiry and keeps failures on retention window', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const deleteCalls = [];

  const directMessageModel = {
    async deleteMany(filter) {
      deleteCalls.push(filter);
      return { deletedCount: 3 };
    },
  };

  await pruneOldReceipts({
    now,
    directMessageModel,
  });

  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0], {
    $or: [
      {
        status: 'delivered',
        $or: [
          { expiresAt: { $lte: now } },
          { deliveredAt: { $lte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
          { updatedAt: { $lte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
        ],
      },
      {
        status: { $in: ['rekey_required', 'same_key_retry_required', 'failed_same_key', 'undelivered'] },
        updatedAt: { $lte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
      },
    ],
  });
});

test('pruneOldAttachmentReceipts deletes old terminal attachment records after deleting blobs', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const deletedIds = [];
  const deleteCommands = [];

  const attachments = [
    { _id: 'att-r1', objectKey: 'messaging-attachments/u2/file-r1.bin' },
    { _id: 'att-r2', objectKey: 'messaging-attachments/u2/file-r2.bin' },
  ];

  const attachmentModel = {
    find(filter) {
      assert.deepEqual(filter, {
        status: { $in: ['received', 'deleted', 'expired'] },
        updatedAt: { $lte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
      });
      return buildQueryReturning(attachments);
    },
    async deleteMany(filter) {
      deletedIds.push(...filter._id.$in);
      return { deletedCount: filter._id.$in.length };
    },
  };

  const storageClient = {
    async send(command) {
      deleteCommands.push(command.input);
      return {};
    },
  };

  await pruneOldAttachmentReceipts({
    now,
    attachmentModel,
    storageClient,
    bucket: 'split-test-bucket',
  });

  assert.equal(deleteCommands.length, 2);
  assert.deepEqual(deleteCommands.map((entry) => entry.Key), [
    'messaging-attachments/u2/file-r1.bin',
    'messaging-attachments/u2/file-r2.bin',
  ]);
  assert.deepEqual(deletedIds, ['att-r1', 'att-r2']);
});
