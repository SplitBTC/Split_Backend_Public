const cron = require('node-cron');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const DirectMessage = require('../models/DirectMessage');
const MessageAttachment = require('../models/MessageAttachment');
const s3Client = require('../integrations/r2');

const RECEIPT_RETENTION_DAYS = 7;
const DELIVERED_RECEIPT_RETENTION_HOURS = 24;
const ATTACHMENT_TERMINAL_STATUSES = ['received', 'deleted', 'expired'];
const NON_DELIVERED_RECEIPT_STATUSES = [
  'rekey_required',
  'same_key_retry_required',
  'failed_same_key',
  'undelivered',
];

async function expirePendingMessages({ now = new Date(), directMessageModel = DirectMessage } = {}) {

  const result = await directMessageModel.updateMany(
    {
      status: 'pending',
      expiresAt: { $lte: now },
    },
    {
      $set: {
        status: 'undelivered',
        expiredAt: now,
      },
      $unset: {
        ciphertext: '',
        nonce: '',
        senderEphemeralPubkey: '',
      },
    }
  );

  if (result.modifiedCount) {
    console.log(`Messaging relay cleanup: expired ${result.modifiedCount} pending message(s)`);
  }
}

async function pruneOldReceipts({
  now = new Date(),
  directMessageModel = DirectMessage,
  retentionDays = RECEIPT_RETENTION_DAYS,
  deliveredReceiptRetentionHours = DELIVERED_RECEIPT_RETENTION_HOURS,
} = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deliveredCutoff = new Date(now.getTime() - deliveredReceiptRetentionHours * 60 * 60 * 1000);

  const result = await directMessageModel.deleteMany({
    $or: [
      {
        status: 'delivered',
        $or: [
          { expiresAt: { $lte: now } },
          { deliveredAt: { $lte: deliveredCutoff } },
          { updatedAt: { $lte: deliveredCutoff } },
        ],
      },
      {
        status: { $in: NON_DELIVERED_RECEIPT_STATUSES },
        updatedAt: { $lte: cutoff },
      },
    ],
  });

  if (result.deletedCount) {
    console.log(`Messaging relay cleanup: pruned ${result.deletedCount} old receipt(s)`);
  }
}

async function deleteAttachmentObjectIfPresent({
  attachment,
  storageClient = s3Client,
  bucket = process.env.R2_BUCKET,
}) {
  if (!attachment?.objectKey || !bucket) {
    return;
  }

  try {
    await storageClient.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: attachment.objectKey,
    }));
  } catch (error) {
    console.warn('Messaging relay cleanup: failed to delete attachment object:', error);
  }
}

async function expirePendingAttachments({
  now = new Date(),
  attachmentModel = MessageAttachment,
  storageClient = s3Client,
  bucket = process.env.R2_BUCKET,
} = {}) {
  const attachments = await attachmentModel.find({
    status: { $in: ['uploaded', 'linked'] },
    expiresAt: { $lte: now },
  }).select('_id objectKey status deletedAt');

  if (!attachments.length) {
    return;
  }

  let expiredCount = 0;

  for (const attachment of attachments) {
    await deleteAttachmentObjectIfPresent({
      attachment,
      storageClient,
      bucket,
    });

    attachment.status = 'expired';
    attachment.deletedAt = attachment.deletedAt || now;
    await attachment.save();
    expiredCount += 1;
  }

  if (expiredCount) {
    console.log(`Messaging relay cleanup: expired ${expiredCount} attachment(s)`);
  }
}

async function pruneOldAttachmentReceipts({
  now = new Date(),
  attachmentModel = MessageAttachment,
  storageClient = s3Client,
  bucket = process.env.R2_BUCKET,
  retentionDays = RECEIPT_RETENTION_DAYS,
} = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const attachments = await attachmentModel.find({
    status: { $in: ATTACHMENT_TERMINAL_STATUSES },
    updatedAt: { $lte: cutoff },
  }).select('_id objectKey');

  if (!attachments.length) {
    return;
  }

  for (const attachment of attachments) {
    await deleteAttachmentObjectIfPresent({
      attachment,
      storageClient,
      bucket,
    });
  }

  const result = await attachmentModel.deleteMany({
    _id: { $in: attachments.map((attachment) => attachment._id) },
  });

  if (result.deletedCount) {
    console.log(`Messaging relay cleanup: pruned ${result.deletedCount} old attachment receipt(s)`);
  }
}

function startMessagingRelayCleanup() {
  const runCleanup = async () => {
    try {
      await expirePendingMessages();
      await pruneOldReceipts();
      await expirePendingAttachments();
      await pruneOldAttachmentReceipts();
    } catch (error) {
      console.error('Messaging relay cleanup failed:', error);
    }
  };

  void runCleanup();
  cron.schedule('*/10 * * * *', runCleanup);
}

module.exports = {
  ATTACHMENT_TERMINAL_STATUSES,
  DELIVERED_RECEIPT_RETENTION_HOURS,
  NON_DELIVERED_RECEIPT_STATUSES,
  deleteAttachmentObjectIfPresent,
  expirePendingAttachments,
  startMessagingRelayCleanup,
  expirePendingMessages,
  pruneOldAttachmentReceipts,
  pruneOldReceipts,
};
