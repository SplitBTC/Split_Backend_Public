const mongoose = require('mongoose');

const messagingAccountSchema = new mongoose.Schema(
  {
    lightningAddressMessagingHmac: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    walletPubkeyMessagingHmac: {
      type: String,
      required: true,
      index: true,
    },

    activeBindingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingBinding',
      default: null,
      index: true,
    },

    hmacVersion: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

messagingAccountSchema.index({ walletPubkeyMessagingHmac: 1, updatedAt: -1 });

module.exports = mongoose.model('MessagingAccount', messagingAccountSchema);
