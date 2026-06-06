const mongoose = require('mongoose');

const userBlockV4Schema = new mongoose.Schema(
  {
    blockerMessagingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingAccount',
      required: true,
      index: true,
    },

    blockedMessagingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingAccount',
      required: true,
      index: true,
    },

    blockedLightningAddressMessagingHmac: {
      type: String,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

userBlockV4Schema.index(
  { blockerMessagingAccountId: 1, blockedMessagingAccountId: 1 },
  { unique: true }
);
userBlockV4Schema.index({ blockerMessagingAccountId: 1, createdAt: -1 });
userBlockV4Schema.index({ blockedMessagingAccountId: 1, blockerMessagingAccountId: 1 });

module.exports = mongoose.model('UserBlockV4', userBlockV4Schema);
