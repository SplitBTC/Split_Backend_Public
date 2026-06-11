const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    walletPubkeyUserHmac: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    walletPubkeyUserHmacVersion: {
      type: String,
      default: null,
    },

    sparkAddress: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    sparkAddressCiphertext: {
      type: String,
      default: null,
    },

    sparkAddressIv: {
      type: String,
      default: null,
    },

    sparkAddressAuthTag: {
      type: String,
      default: null,
    },

    sparkAddressKeyVersion: {
      type: String,
      default: null,
    },

    sparkAddressUserHmac: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    sparkAddressUserHmacVersion: {
      type: String,
      default: null,
    },

    profilePicUrl: {
      type: String,
      default: null,
    },

    accountCreatedDate: {
      type: Date,
      default: Date.now,
    },

    lastLoginDate: {
      type: Date,
    },

  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
