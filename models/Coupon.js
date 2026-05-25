const mongoose = require('mongoose');

const { Schema } = mongoose;

const POSTAL_CODE_REGEX = /^\d{5}(?:-\d{4})?$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const geoPointSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['Point'],
      required: true,
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator(value) {
          return Array.isArray(value)
            && value.length === 2
            && value.every((entry) => Number.isFinite(entry))
            && value[0] >= -180
            && value[0] <= 180
            && value[1] >= -90
            && value[1] <= 90;
        },
        message: 'geoPoint coordinates must be [longitude, latitude].',
      },
    },
  },
  { _id: false }
);

const primaryBusinessAddressSchema = new Schema(
  {
    formattedAddress: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
    },
    line1: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    line2: {
      type: String,
      default: '',
      trim: true,
      maxlength: 120,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    state: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },
    postalCode: {
      type: String,
      required: true,
      trim: true,
      match: [POSTAL_CODE_REGEX, 'postalCode format is invalid'],
    },
    countryCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      enum: ['US'],
      default: 'US',
    },
    placeId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    latitude: {
      type: Number,
      required: true,
      min: -90,
      max: 90,
    },
    longitude: {
      type: Number,
      required: true,
      min: -180,
      max: 180,
    },
    geoPoint: {
      type: geoPointSchema,
      required: true,
    },
  },
  { _id: false }
);

const couponSchema = new Schema(
  {
    businessName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    businessLogoUrl: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    businessLogoObjectKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    contactEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
      match: [EMAIL_REGEX, 'contactEmail format is invalid'],
    },
    dealDescription: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'approved'],
      default: 'pending',
      index: true,
    },
    appliesToAllLocations: {
      type: Boolean,
      required: true,
      default: true,
    },
    primaryBusinessAddress: {
      type: primaryBusinessAddressSchema,
      required: true,
    },
  },
  { timestamps: true }
);

couponSchema.index({ status: 1, createdAt: -1 });
couponSchema.index({ 'primaryBusinessAddress.postalCode': 1, status: 1 });
couponSchema.index({ 'primaryBusinessAddress.geoPoint': '2dsphere' });

module.exports = mongoose.model('Coupon', couponSchema);
