const mongoose = require('mongoose');

const messagingDeviceRegistrationV4Schema = new mongoose.Schema(
  {
    messagingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessagingAccount',
      required: true,
      index: true,
    },

    messagingPubkeyHmac: {
      type: String,
      default: null,
      index: true,
    },

    platform: {
      type: String,
      enum: ['apns', 'fcm'],
      required: true,
    },

    environment: {
      type: String,
      enum: ['dev', 'prod'],
      required: true,
      index: true,
    },

    deviceTokenCiphertext: {
      type: String,
      required: true,
    },

    deviceTokenIv: {
      type: String,
      required: true,
    },

    deviceTokenAuthTag: {
      type: String,
      required: true,
    },

    deviceTokenKeyVersion: {
      type: String,
      required: true,
    },

    deviceTokenLookupHmac: {
      type: String,
      required: true,
      index: true,
    },

    registrationSignature: {
      type: String,
      required: true,
    },

    registrationSignatureVersion: {
      type: Number,
      required: true,
    },

    registrationSignedAt: {
      type: Date,
      required: true,
    },

    appVersion: {
      type: String,
      default: null,
    },

    bundleId: {
      type: String,
      default: null,
    },

    lastSeenAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

messagingDeviceRegistrationV4Schema.index(
  { environment: 1, deviceTokenLookupHmac: 1 },
  { unique: true }
);
messagingDeviceRegistrationV4Schema.index({
  messagingAccountId: 1,
  environment: 1,
  updatedAt: -1,
});
messagingDeviceRegistrationV4Schema.index({
  messagingAccountId: 1,
  messagingPubkeyHmac: 1,
  environment: 1,
});

module.exports = mongoose.model('MessagingDeviceRegistrationV4', messagingDeviceRegistrationV4Schema);
