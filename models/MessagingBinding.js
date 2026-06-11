const mongoose = require('mongoose');

const messagingBindingSchema = new mongoose.Schema(
  {
    messagingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingAccount',
      required: true,
      index: true,
    },

    walletPubkey: {
      type: String,
      required: true,
    },

    lightningAddressHash: {
      type: String,
      required: true,
      index: true,
    },

    lightningAddressHashScheme: {
      type: String,
      required: true,
    },

    messagingPubkey: {
      type: String,
      required: true,
    },

    messagingPubkeyMessagingHmac: {
      type: String,
      default: null,
      index: true,
    },

    bindingPayloadMessagingHmac: {
      type: String,
      default: null,
      index: true,
    },

    bindingPayloadCiphertext: {
      type: String,
      default: null,
    },

    bindingPayloadIv: {
      type: String,
      default: null,
    },

    bindingPayloadAuthTag: {
      type: String,
      default: null,
    },

    bindingPayloadKeyVersion: {
      type: String,
      default: null,
    },

    messagingIdentitySignature: {
      type: String,
      required: true,
    },

    messagingIdentitySignatureVersion: {
      type: Number,
      required: true,
    },

    messagingIdentitySignedAt: {
      type: Date,
      required: true,
      index: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

messagingBindingSchema.index({ messagingAccountId: 1, active: 1, updatedAt: -1 });
messagingBindingSchema.index(
  {
    messagingAccountId: 1,
    bindingPayloadMessagingHmac: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      bindingPayloadMessagingHmac: { $type: 'string' },
    },
  }
);
messagingBindingSchema.index(
  {
    messagingAccountId: 1,
    lightningAddressHash: 1,
    messagingPubkey: 1,
    messagingIdentitySignature: 1,
    messagingIdentitySignatureVersion: 1,
    messagingIdentitySignedAt: 1,
  },
  { unique: true }
);

module.exports = mongoose.model('MessagingBinding', messagingBindingSchema);
