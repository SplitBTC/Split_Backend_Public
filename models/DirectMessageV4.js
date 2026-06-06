const mongoose = require('mongoose');

const directMessageV4Schema = new mongoose.Schema(
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

    senderMessagingPubkey: {
      type: String,
      required: true,
    },

    recipientMessagingPubkey: {
      type: String,
      required: true,
      index: true,
    },

    clientMessageId: {
      type: String,
      required: true,
    },

    messageType: {
      type: String,
      default: 'text',
      enum: ['text', 'payment_request', 'payment_request_paid', 'attachment', 'reaction'],
    },

    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: [
        'pending',
        'delivered',
        'rekey_required',
        'same_key_retry_required',
        'failed_same_key',
        'undelivered',
      ],
      index: true,
    },

    sameKeyRetryCount: {
      type: Number,
      default: 0,
    },

    envelopeVersion: {
      type: Number,
      default: 4,
    },

    ciphertext: {
      type: String,
      default: null,
    },

    nonce: {
      type: String,
      default: null,
    },

    senderEphemeralPubkey: {
      type: String,
      default: null,
    },

    createdAtClient: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    deliveredAt: {
      type: Date,
      default: null,
    },

    rekeyRequiredAt: {
      type: Date,
      default: null,
    },

    sameKeyDecryptFailedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    expiredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

directMessageV4Schema.index(
  { senderMessagingAccountId: 1, clientMessageId: 1 },
  { unique: true }
);
directMessageV4Schema.index({
  recipientMessagingAccountId: 1,
  recipientMessagingPubkey: 1,
  status: 1,
  createdAt: 1,
});
directMessageV4Schema.index({
  senderMessagingAccountId: 1,
  status: 1,
  updatedAt: -1,
});

module.exports = mongoose.model('DirectMessageV4', directMessageV4Schema);
