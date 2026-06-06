const cron = require('node-cron');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const DirectMessage = require('../models/DirectMessage');
const DirectMessageV4 = require('../models/DirectMessageV4');
const MessageAttachment = require('../models/MessageAttachment');
const MessageAttachmentV4 = require('../models/MessageAttachmentV4');
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

const DIRECT_MESSAGE_MODELS = [
  { model: DirectMessage, label: '' },
  { model: DirectMessageV4, label: ' v4' },
];
const ATTACHMENT_MODELS = [
  { model: MessageAttachment, label: '' },
  { model: MessageAttachmentV4, label: ' v4' },
];

async function expirePendingMessages({
  now = new Date(),
  directMessageModel = DirectMessage,
  modelLabel = '',
} = {}) {

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
    console.log(`Messaging relay cleanup: expired ${result.modifiedCount}${modelLabel} pending message(s)`);
  }
}

async function expirePendingMessagesForAllVersions({
  now = new Date(),
  directMessageModels = DIRECT_MESSAGE_MODELS,
} = {}) {
  for (const { model, label } of directMessageModels) {
    await expirePendingMessages({
      now,
      directMessageModel: model,
      modelLabel: label,
    });
  }
}

async function pruneOldReceipts({
  now = new Date(),
  directMessageModel = DirectMessage,
  modelLabel = '',
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
    console.log(`Messaging relay cleanup: pruned ${result.deletedCount}${modelLabel} old receipt(s)`);
  }
}

async function pruneOldReceiptsForAllVersions({
  now = new Date(),
  directMessageModels = DIRECT_MESSAGE_MODELS,
  retentionDays = RECEIPT_RETENTION_DAYS,
  deliveredReceiptRetentionHours = DELIVERED_RECEIPT_RETENTION_HOURS,
} = {}) {
  for (const { model, label } of directMessageModels) {
    await pruneOldReceipts({
      now,
      directMessageModel: model,
      modelLabel: label,
      retentionDays,
      deliveredReceiptRetentionHours,
    });
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
  modelLabel = '',
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
    console.log(`Messaging relay cleanup: expired ${expiredCount}${modelLabel} attachment(s)`);
  }
}

async function expirePendingAttachmentsForAllVersions({
  now = new Date(),
  attachmentModels = ATTACHMENT_MODELS,
  storageClient = s3Client,
  bucket = process.env.R2_BUCKET,
} = {}) {
  for (const { model, label } of attachmentModels) {
    await expirePendingAttachments({
      now,
      attachmentModel: model,
      modelLabel: label,
      storageClient,
      bucket,
    });
  }
}

async function pruneOldAttachmentReceipts({
  now = new Date(),
  attachmentModel = MessageAttachment,
  modelLabel = '',
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
    console.log(`Messaging relay cleanup: pruned ${result.deletedCount}${modelLabel} old attachment receipt(s)`);
  }
}

async function pruneOldAttachmentReceiptsForAllVersions({
  now = new Date(),
  attachmentModels = ATTACHMENT_MODELS,
  storageClient = s3Client,
  bucket = process.env.R2_BUCKET,
  retentionDays = RECEIPT_RETENTION_DAYS,
} = {}) {
  for (const { model, label } of attachmentModels) {
    await pruneOldAttachmentReceipts({
      now,
      attachmentModel: model,
      modelLabel: label,
      storageClient,
      bucket,
      retentionDays,
    });
  }
}

function startMessagingRelayCleanup() {
  const runCleanup = async () => {
    try {
      await expirePendingMessagesForAllVersions();
      await pruneOldReceiptsForAllVersions();
      await expirePendingAttachmentsForAllVersions();
      await pruneOldAttachmentReceiptsForAllVersions();
    } catch (error) {
      console.error('Messaging relay cleanup failed:', error);
    }
  };

  void runCleanup();
  cron.schedule('*/10 * * * *', runCleanup);
}

module.exports = {
  ATTACHMENT_TERMINAL_STATUSES,
  ATTACHMENT_MODELS,
  DELIVERED_RECEIPT_RETENTION_HOURS,
  DIRECT_MESSAGE_MODELS,
  NON_DELIVERED_RECEIPT_STATUSES,
  deleteAttachmentObjectIfPresent,
  expirePendingAttachments,
  expirePendingAttachmentsForAllVersions,
  expirePendingMessagesForAllVersions,
  startMessagingRelayCleanup,
  expirePendingMessages,
  pruneOldAttachmentReceipts,
  pruneOldAttachmentReceiptsForAllVersions,
  pruneOldReceipts,
  pruneOldReceiptsForAllVersions,
};
