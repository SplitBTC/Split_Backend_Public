const mongoose = require("mongoose");

const RewardPayoutAllocationSchema = new mongoose.Schema(
  {
    monthKey: {
      type: String,
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    rewardSpendCents: {
      type: Number,
      required: true,
      min: 0,
    },

    transactionCount: {
      type: Number,
      required: true,
      min: 0,
    },

    rewardSats: {
      type: Number,
      required: true,
      min: 0,
    },

    sparkAddress: {
      type: String,
      default: null,
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

    closed: {
      type: Boolean,
      default: false,
      index: true,
    },

    paid: {
      type: Boolean,
      default: false,
      index: true,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

RewardPayoutAllocationSchema.index({ monthKey: 1, userId: 1 }, { unique: true });
RewardPayoutAllocationSchema.index({ monthKey: 1, paid: 1 });

module.exports = mongoose.model("RewardPayoutAllocation", RewardPayoutAllocationSchema);
