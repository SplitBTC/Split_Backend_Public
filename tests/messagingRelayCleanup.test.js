const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expirePendingMessages,
  expirePendingMessagesForActiveModels,
  expirePendingAttachments,
  expirePendingAttachmentsForActiveModels,
  pruneOldAttachmentReceipts,
  pruneOldAttachmentReceiptsForActiveModels,
  pruneOldReceipts,
  pruneOldReceiptsForActiveModels,
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
      objectKey: 'messaging-v4-attachments/u1/file-1.bin',
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
      objectKey: 'messaging-v4-attachments/u1/file-2.bin',
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
    'messaging-v4-attachments/u1/file-1.bin',
    'messaging-v4-attachments/u1/file-2.bin',
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

test('expirePendingAttachmentsForActiveModels expires configured attachment collections', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const saveCalls = [];
  const deleteCommands = [];

  function buildAttachmentModel(name) {
    return {
      find(filter) {
        assert.deepEqual(filter, {
          status: { $in: ['uploaded', 'linked'] },
          expiresAt: { $lte: now },
        });

        return buildQueryReturning([
          {
            _id: `${name}-att-1`,
            objectKey: `messaging-${name}-attachments/file.bin`,
            status: 'uploaded',
            deletedAt: null,
            async save() {
              saveCalls.push({ name, status: this.status, deletedAt: this.deletedAt });
            },
          },
        ]);
      },
    };
  }

  const storageClient = {
    async send(command) {
      deleteCommands.push(command.input);
      return {};
    },
  };

  await expirePendingAttachmentsForActiveModels({
    now,
    attachmentModels: [{ model: buildAttachmentModel('v4'), label: ' v4' }],
    storageClient,
    bucket: 'split-test-bucket',
  });

  assert.deepEqual(saveCalls.map((entry) => entry.name), ['v4']);
  assert.deepEqual(saveCalls.map((entry) => entry.status), ['expired']);
  assert.deepEqual(saveCalls.map((entry) => entry.deletedAt), [now]);
  assert.deepEqual(deleteCommands.map((entry) => entry.Key), [
    'messaging-v4-attachments/file.bin',
  ]);
});

test('expirePendingMessagesForActiveModels expires configured relay collections', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const updateCalls = [];

  function buildDirectMessageModel(name) {
    return {
      async updateMany(filter, update) {
        updateCalls.push({ name, filter, update });
        return { modifiedCount: 1 };
      },
    };
  }

  await expirePendingMessagesForActiveModels({
    now,
    directMessageModels: [{ model: buildDirectMessageModel('v4'), label: ' v4' }],
  });

  assert.deepEqual(updateCalls.map((entry) => entry.name), ['v4']);
  for (const call of updateCalls) {
    assert.deepEqual(call.filter, {
      status: 'pending',
      expiresAt: { $lte: now },
    });
    assert.deepEqual(call.update, {
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
  }
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

test('pruneOldReceiptsForActiveModels prunes configured relay receipts', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const deleteCalls = [];

  function buildDirectMessageModel(name) {
    return {
      async deleteMany(filter) {
        deleteCalls.push({ name, filter });
        return { deletedCount: 1 };
      },
    };
  }

  await pruneOldReceiptsForActiveModels({
    now,
    directMessageModels: [{ model: buildDirectMessageModel('v4'), label: ' v4' }],
  });

  assert.deepEqual(deleteCalls.map((entry) => entry.name), ['v4']);
  for (const call of deleteCalls) {
    assert.deepEqual(call.filter, {
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
  }
});

test('pruneOldAttachmentReceipts deletes old terminal attachment records after deleting blobs', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const deletedIds = [];
  const deleteCommands = [];

  const attachments = [
    { _id: 'att-r1', objectKey: 'messaging-v4-attachments/u2/file-r1.bin' },
    { _id: 'att-r2', objectKey: 'messaging-v4-attachments/u2/file-r2.bin' },
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
    'messaging-v4-attachments/u2/file-r1.bin',
    'messaging-v4-attachments/u2/file-r2.bin',
  ]);
  assert.deepEqual(deletedIds, ['att-r1', 'att-r2']);
});

test('pruneOldAttachmentReceiptsForActiveModels prunes configured terminal attachment records', async () => {
  const now = new Date('2026-04-02T12:00:00.000Z');
  const deleteCommands = [];
  const deleteCalls = [];

  function buildAttachmentModel(name) {
    return {
      find(filter) {
        assert.deepEqual(filter, {
          status: { $in: ['received', 'deleted', 'expired'] },
          updatedAt: { $lte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        });

        return buildQueryReturning([
          { _id: `${name}-att-r1`, objectKey: `messaging-${name}-attachments/old.bin` },
        ]);
      },
      async deleteMany(filter) {
        deleteCalls.push({ name, ids: filter._id.$in });
        return { deletedCount: filter._id.$in.length };
      },
    };
  }

  const storageClient = {
    async send(command) {
      deleteCommands.push(command.input);
      return {};
    },
  };

  await pruneOldAttachmentReceiptsForActiveModels({
    now,
    attachmentModels: [{ model: buildAttachmentModel('v4'), label: ' v4' }],
    storageClient,
    bucket: 'split-test-bucket',
  });

  assert.deepEqual(deleteCalls.map((entry) => entry.name), ['v4']);
  assert.deepEqual(deleteCalls.map((entry) => entry.ids), [['v4-att-r1']]);
  assert.deepEqual(deleteCommands.map((entry) => entry.Key), [
    'messaging-v4-attachments/old.bin',
  ]);
});
