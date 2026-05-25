const mongoose = require('mongoose');

const { Schema } = mongoose;

const POSTAL_CODE_REGEX = /^\d{5}(?:-\d{4})?$/;

const bitcoinEventSchema = new Schema(
  {
    source: {
      type: String,
      required: true,
      enum: ['luma'],
      default: 'luma',
    },
    sourceUrl: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      maxlength: 500,
    },
    externalEventId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000,
    },
    coverImageUrl: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    hostName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 120,
    },

    startsAt: {
      type: Date,
      required: true,
    },
    endsAt: {
      type: Date,
      default: null,
    },
    timezone: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80,
    },

    venueName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
    address: {
      type: String,
      default: '',
      trim: true,
      maxlength: 240,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    region: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },
    postalCode: {
      type: String,
      default: '',
      trim: true,
      validate: {
        validator(value) {
          return value === '' || POSTAL_CODE_REGEX.test(value);
        },
        message: 'postalCode format is invalid',
      },
    },
    country: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      enum: ['US'],
      default: 'US',
    },
    latitude: {
      type: Number,
      min: -90,
      max: 90,
      default: null,
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180,
      default: null,
    },
  },
  { timestamps: true }
);

bitcoinEventSchema.index({ startsAt: 1 });
bitcoinEventSchema.index({ country: 1, startsAt: 1 });
bitcoinEventSchema.index({ latitude: 1, longitude: 1 });
bitcoinEventSchema.index({ source: 1, externalEventId: 1 }, { unique: true });

module.exports = mongoose.model('BitcoinEvent', bitcoinEventSchema);
