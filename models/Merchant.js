const mongoose = require('mongoose');

const merchantAddressSchema = new mongoose.Schema(
  {
    formattedAddress: {
      type: String,
      required: true,
      trim: true,
    },
    googlePlaceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
	    },
	    street: {
	      type: String,
	      required: true,
	      trim: true,
	    },
	    city: {
	      type: String,
	      required: true,
	      trim: true,
	    },
	    state: {
	      type: String,
	      required: true,
	      trim: true,
	    },
	    postalCode: {
	      type: String,
	      required: true,
	      trim: true,
	    },
	    lat: {
	      type: Number,
      required: true,
      min: -90,
      max: 90,
    },
    lng: {
      type: Number,
      required: true,
      min: -180,
      max: 180,
    },
  },
  { _id: false }
);

const merchantSchema = new mongoose.Schema(
	  {
	    businessName: {
	      type: String,
	      required: true,
	      trim: true,
	    },
	    sparkWalletPubkey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
      trim: true,
      lowercase: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: merchantAddressSchema,
      required: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Merchant', merchantSchema);
