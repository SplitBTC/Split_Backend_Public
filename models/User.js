const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // 🔑 canonical identity
    walletPubkey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
    },

    sparkAddress: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    lightningAddress: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    profilePicUrl: {
      type: String,
      default: null,
    },

    messagingPubkeyV2: {
      type: String,
      default: null,
      index: true,
    },

    messagingIdentityV2Signature: {
      type: String,
      default: null,
    },

    messagingIdentityV2SignatureVersion: {
      type: Number,
      default: null,
    },

    messagingIdentityV2SignedAt: {
      type: Date,
      default: null,
    },

    messagingIdentityV2UpdatedAt: {
      type: Date,
      default: null,
    },

    accountCreatedDate: {
      type: Date,
      default: Date.now,
    },

    lastLoginDate: {
      type: Date,
    },

    lifetimeMerchantSpendCents: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
