const mongoose = require("mongoose");

const RewardSpendPaymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    paymentHash: {
      type: String,
      trim: true,
    },

    paymentHashHash: {
      type: String,
      trim: true,
    },

    invoiceHash: {
      type: String,
      trim: true,
      index: true,
    },

    destinationPubkey: {
      type: String,
      trim: true,
      index: true,
    },

    merchantPubkeyHash: {
      type: String,
      trim: true,
      index: true,
    },

    btcAmountSats: {
      type: Number,
      required: true,
      min: 1,
    },

    usdAmountCents: {
      type: Number,
      required: true,
      min: 1,
    },

    network: {
      type: String,
      required: true,
      enum: ["lightning"],
      default: "lightning",
    },

    direction: {
      type: String,
      required: true,
      enum: ["sent"],
      default: "sent",
    },

    status: {
      type: String,
      required: true,
      enum: ["Completed"],
      default: "Completed",
    },

    monthKey: {
      type: String,
      required: true,
      index: true,
    },

    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },

    verificationMethod: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

RewardSpendPaymentSchema.index(
  { paymentHash: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentHash: { $type: "string" },
    },
  }
);
RewardSpendPaymentSchema.index(
  { paymentHashHash: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentHashHash: { $type: "string" },
    },
  }
);
RewardSpendPaymentSchema.index({ userId: 1, monthKey: 1 });
RewardSpendPaymentSchema.index({ destinationPubkey: 1, monthKey: 1 });
RewardSpendPaymentSchema.index({ merchantPubkeyHash: 1, monthKey: 1 });

module.exports = mongoose.model("RewardSpendPayment", RewardSpendPaymentSchema);
