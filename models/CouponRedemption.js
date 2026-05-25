const mongoose = require('mongoose');

const { Schema } = mongoose;

const REDEMPTION_MONTH_REGEX = /^\d{4}-\d{2}$/;

const couponRedemptionSchema = new Schema(
  {
    couponId: {
      type: Schema.Types.ObjectId,
      ref: 'Coupon',
      required: true,
      immutable: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
      index: true,
    },
    redemptionMonth: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      match: [REDEMPTION_MONTH_REGEX, 'redemptionMonth format is invalid'],
    },
    redeemedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
  },
  { timestamps: true }
);

couponRedemptionSchema.index(
  { couponId: 1, userId: 1, redemptionMonth: 1 },
  { unique: true }
);
couponRedemptionSchema.index({ userId: 1, redemptionMonth: -1, redeemedAt: -1 });
couponRedemptionSchema.index({ couponId: 1, redemptionMonth: -1, redeemedAt: -1 });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
