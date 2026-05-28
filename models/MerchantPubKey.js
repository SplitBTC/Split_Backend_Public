// models/MerchantPubKey.js
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Schema } = mongoose;

const PUBKEY_HASH_VERSION = 'split-merchant-pubkey-sha256-v1';
const PUBKEY_HASH_PREFIX = 'split:merchant-pubkey:v1:';

function normalizePubkey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function hashPubkey(value) {
  const normalizedPubkey = normalizePubkey(value);
  if (!normalizedPubkey) return '';

  return crypto
    .createHash('sha256')
    .update(`${PUBKEY_HASH_PREFIX}${normalizedPubkey}`, 'utf8')
    .digest('hex');
}

const merchantPubKeySchema = new Schema(
  {
    /**
     * The lightning node public key associated with an eligible merchant flow.
     * Pubkeys should be unique in this collection, even if one pubkey may map
     * to many real-world merchants under a custodial processor.
     */
    pubkey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    pubkeyHash: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    pubkeyHashVersion: {
      type: String,
      trim: true,
    },

    pubkeyHashUpdatedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

merchantPubKeySchema.statics.normalizePubkey = normalizePubkey;
merchantPubKeySchema.statics.hashPubkey = hashPubkey;
merchantPubKeySchema.statics.PUBKEY_HASH_VERSION = PUBKEY_HASH_VERSION;
merchantPubKeySchema.statics.PUBKEY_HASH_PREFIX = PUBKEY_HASH_PREFIX;

module.exports = mongoose.model('MerchantPubKey', merchantPubKeySchema);
