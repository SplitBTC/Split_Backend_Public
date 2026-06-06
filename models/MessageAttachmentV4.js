const mongoose = require('mongoose');

const messageAttachmentV4Schema = new mongoose.Schema(
  {
    senderMessagingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingAccount',
      required: true,
      index: true,
    },

    recipientMessagingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingAccount',
      required: true,
      index: true,
    },

    recipientLightningAddressMessagingHmac: {
      type: String,
      required: true,
      index: true,
    },

    objectKey: {
      type: String,
      required: true,
      unique: true,
    },

    uploadContentType: {
      type: String,
      default: 'application/octet-stream',
    },

    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
    },

    status: {
      type: String,
      required: true,
      default: 'uploaded',
      enum: ['uploaded', 'linked', 'received', 'deleted', 'expired'],
      index: true,
    },

    linkedMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DirectMessageV4',
      default: null,
      index: true,
    },

    linkedClientMessageId: {
      type: String,
      default: null,
    },

    receivedAt: {
      type: Date,
      default: null,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

messageAttachmentV4Schema.index({
  senderMessagingAccountId: 1,
  recipientMessagingAccountId: 1,
  status: 1,
  createdAt: 1,
});

module.exports = mongoose.model('MessageAttachmentV4', messageAttachmentV4Schema);
