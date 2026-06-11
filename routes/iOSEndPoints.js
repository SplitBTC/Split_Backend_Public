require('dotenv').config();
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = require('../integrations/r2');
const User = require('../models/User');
const MessagingAccount = require('../models/MessagingAccount');
const MessagingBinding = require('../models/MessagingBinding');
const MessagingDeviceRegistrationV4 = require('../models/MessagingDeviceRegistrationV4');
const DirectMessageV4 = require('../models/DirectMessageV4');
const UserBlockV4 = require('../models/UserBlockV4');
const MessageAttachmentV4 = require('../models/MessageAttachmentV4');
const MerchantPubKey = require('../models/MerchantPubKey');
const PlatformAnalytics = require('../models/PlatformAnalytics');
const PlatformWallet = require('../models/PlatformWallet');
const RewardSpendPayment = require('../models/RewardSpendPayment');
const RewardPayoutAllocation = require('../models/RewardPayoutAllocation');
const userAuthMiddleware = require('../middlewares/userAuthMiddleware');
const rewardClaimEncryption = require('../rewards/rewardClaimEncryption');
const { decodeBolt11 } = require('../rewards/bolt11Invoice');
const { normalizeProof32ByteHex } = require('../rewards/rewardProofEncoding');
const sessionHelper = require('../auth/sessionHelper');
const {
  buildUserPrivacyFields,
} = require('../services/userPrivacy');
const {
  decryptSparkAddress,
  encryptSparkAddress,
  messagingDataHmac,
  normalizeWalletPubkey,
  PAYOUT_DESTINATION_KEY_VERSION,
} = require('../services/privacyCrypto');
const breezApiKey = process.env.BREEZ_API_KEY;
const upload = multer({
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

function getJwtSecretKey() {
  return process.env.secretKey;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function merchantPubkeyQuery(pubkey) {
  const normalizedPubkey = normalizePubkey(pubkey);
  if (!normalizedPubkey) return null;

  return {
    pubkey: {
      $regex: `^${escapeRegExp(normalizedPubkey)}$`,
      $options: 'i',
    },
  };
}

function normalizeHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function wrapPayoutDestinationPrivacyError(error) {
  if (/PAYOUT_DESTINATION_ENCRYPTION_KEY/.test(String(error?.message || error))) {
    const wrappedError = new Error('Payout destination privacy configuration is missing');
    wrappedError.statusCode = 500;
    wrappedError.publicMessage = 'Payout destination privacy configuration is missing';
    throw wrappedError;
  }

  throw error;
}

function buildSparkAddressEncryptionFields(sparkAddress) {
  try {
    return encryptSparkAddress(sparkAddress);
  } catch (error) {
    wrapPayoutDestinationPrivacyError(error);
  }
}

function hasSparkAddressEncryptionFields(user) {
  return Boolean(
    user?.sparkAddressCiphertext &&
    user?.sparkAddressIv &&
    user?.sparkAddressAuthTag &&
    user?.sparkAddressKeyVersion
  );
}

function hasCurrentSparkAddressEncryptionFields(user) {
  return (
    hasSparkAddressEncryptionFields(user) &&
    user.sparkAddressKeyVersion === PAYOUT_DESTINATION_KEY_VERSION
  );
}

function decryptStoredSparkAddress(user) {
  try {
    return decryptSparkAddress({
      sparkAddressCiphertext: user.sparkAddressCiphertext,
      sparkAddressIv: user.sparkAddressIv,
      sparkAddressAuthTag: user.sparkAddressAuthTag,
    });
  } catch (error) {
    wrapPayoutDestinationPrivacyError(error);
  }
}

function resolvePayoutSparkAddressForLogin(user, incomingSparkAddress) {
  const storedPlaintextSparkAddress =
    typeof user?.sparkAddress === 'string' ? user.sparkAddress.trim() : '';
  if (storedPlaintextSparkAddress) {
    return storedPlaintextSparkAddress;
  }

  if (hasSparkAddressEncryptionFields(user)) {
    return decryptStoredSparkAddress(user);
  }

  return incomingSparkAddress;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function r2ObjectKeyFromPublicUrl(publicUrl) {
  if (!publicUrl || typeof publicUrl !== 'string') {
    return '';
  }

  const trimmed = publicUrl.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsedUrl = new URL(trimmed);
    return decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  } catch (_error) {
    return trimmed.split('?')[0].split('/').pop() || '';
  }
}

async function deleteProfilePictureFromR2(profilePicUrl) {
  const objectKey = r2ObjectKeyFromPublicUrl(profilePicUrl);
  if (!objectKey) {
    return false;
  }

  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
    }));
    return true;
  } catch (error) {
    console.warn('Failed to delete profile picture during account deletion:', error.message);
    return false;
  }
}

async function deleteObjectFromR2(objectKey, logContext) {
  if (!objectKey || typeof objectKey !== 'string') {
    return false;
  }

  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
    }));
    return true;
  } catch (error) {
    console.warn(`Failed to delete ${logContext} from R2:`, error.message);
    return false;
  }
}

async function deleteMessagingV4AccountDataForWalletPubkey(rawWalletPubkey) {
  const walletPubkey = normalizeWalletPubkey(rawWalletPubkey);
  if (!walletPubkey) {
    return null;
  }

  let walletPubkeyMessagingHmac;
  try {
    walletPubkeyMessagingHmac = messagingDataHmac(walletPubkey);
  } catch (error) {
    console.warn('Skipping v4 messaging cleanup during account deletion:', error.message);
    return null;
  }

  const messagingAccount = await MessagingAccount
    .findOne({ walletPubkeyMessagingHmac })
    .select('_id');
  if (!messagingAccount) {
    return {
      account: 0,
      bindings: 0,
      deviceRegistrations: 0,
      userBlocks: 0,
      directMessages: 0,
      attachments: 0,
      attachmentObjectsDeleted: 0,
    };
  }

  const messagingAccountId = messagingAccount._id;
  const ownedAttachmentFilter = {
    $or: [
      { senderMessagingAccountId: messagingAccountId },
      { recipientMessagingAccountId: messagingAccountId },
    ],
  };
  const attachmentDocs = await MessageAttachmentV4
    .find(ownedAttachmentFilter)
    .select('_id objectKey');

  let attachmentObjectsDeleted = 0;
  await Promise.all(attachmentDocs.map(async (attachment) => {
    const deleted = await deleteObjectFromR2(attachment.objectKey, 'v4 messaging attachment');
    if (deleted) {
      attachmentObjectsDeleted += 1;
    }
  }));

  const attachmentIds = attachmentDocs.map((attachment) => attachment._id);
  const attachmentDeleteFilter = attachmentIds.length
    ? { _id: { $in: attachmentIds } }
    : ownedAttachmentFilter;

  const [
    attachmentResult,
    directMessageResult,
    userBlockResult,
    deviceRegistrationResult,
    bindingResult,
    accountResult,
  ] = await Promise.all([
    MessageAttachmentV4.deleteMany(attachmentDeleteFilter),
    DirectMessageV4.deleteMany({
      $or: [
        { senderMessagingAccountId: messagingAccountId },
        { recipientMessagingAccountId: messagingAccountId },
      ],
    }),
    UserBlockV4.deleteMany({
      $or: [
        { blockerMessagingAccountId: messagingAccountId },
        { blockedMessagingAccountId: messagingAccountId },
      ],
    }),
    MessagingDeviceRegistrationV4.deleteMany({ messagingAccountId }),
    MessagingBinding.deleteMany({ messagingAccountId }),
    MessagingAccount.deleteOne({ _id: messagingAccountId }),
  ]);

  return {
    account: accountResult.deletedCount || 0,
    bindings: bindingResult.deletedCount || 0,
    deviceRegistrations: deviceRegistrationResult.deletedCount || 0,
    userBlocks: userBlockResult.deletedCount || 0,
    directMessages: directMessageResult.deletedCount || 0,
    attachments: attachmentResult.deletedCount || 0,
    attachmentObjectsDeleted,
  };
}

const rewardsMinimumVersions = Object.freeze({
  ios: '4.4.3',
  android: '0.7.3',
});

function getRewardsMinimumVersion(platform) {
  const requestedPlatform = String(platform || '').trim().toLowerCase();

  // Keep missing platform mapped to iOS so already-released iOS builds
  // continue receiving the correct minimum version until they start
  // sending platform=ios explicitly.
  return requestedPlatform === 'android'
    ? rewardsMinimumVersions.android
    : rewardsMinimumVersions.ios;
}

router.get('/rewards-version-check', async (req, res) => {
  try {
      const minimumVersion = getRewardsMinimumVersion(req.query.platform);

      return res.status(200).json({ minimumVersion });
  } catch (error) {
      console.error("Version check error:", error);
      return res.status(500).json({ error: "Server error" });
  }
});

router.get('/v1/reward-merchant-pubkey-hashes', async (req, res) => {
  try {
    const hashVersion = MerchantPubKey.PUBKEY_HASH_VERSION;
    const records = await MerchantPubKey.find({})
      .select('_id pubkey pubkeyHash pubkeyHashVersion')
      .lean();

    const hashSet = new Set();
    const backfills = [];
    const now = new Date();

    for (const record of records) {
      const computedHash = MerchantPubKey.hashPubkey(record.pubkey);
      if (!computedHash) continue;

      hashSet.add(computedHash);

      if (record.pubkeyHash !== computedHash || record.pubkeyHashVersion !== hashVersion) {
        backfills.push(
          MerchantPubKey.updateOne(
            { _id: record._id },
            {
              $set: {
                pubkeyHash: computedHash,
                pubkeyHashVersion: hashVersion,
                pubkeyHashUpdatedAt: now,
              },
            }
          )
        );
      }
    }

    if (backfills.length > 0) {
      await Promise.all(backfills);
    }

    const hashes = Array.from(hashSet).sort();
    const etag = `"${crypto
      .createHash('sha256')
      .update(`${hashVersion}:${hashes.join(',')}`, 'utf8')
      .digest('hex')}"`;

    res.set('Cache-Control', 'public, max-age=3600');
    res.set('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    return res.status(200).json({
      ok: true,
      algorithm: 'sha256',
      normalization: 'trim-lowercase',
      hashVersion,
      hashPrefix: MerchantPubKey.PUBKEY_HASH_PREFIX,
      cacheTtlSeconds: 3600,
      count: hashes.length,
      hashes,
    });
  } catch (error) {
    console.error('Merchant pubkey hash list error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/breez-api-key', async (req, res) => {
  try {
      if (!breezApiKey) {
          console.error("Missing BREEZ_API_KEY in environment");
          return res.status(500).json({ error: "Server misconfiguration" });
      }

      return res.status(200).json({ apiKey: breezApiKey });
  } catch (error) {
      console.error("Breez API key route error:", error);
      return res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------
//  POST /auth/nonce
//  Returns a short-lived nonce + canonical messageToSign.
// ------------------------------------------------------
router.post('/auth/nonce', async (req, res) => {
  try {
    // domain separation helps prevent signatures being reused elsewhere
    const domain = process.env.WALLET_AUTH_DOMAIN || 'example.invalid';

    const { nonce, expiresAt, messageToSign } = sessionHelper.issueNonce({ domain });

    return res.status(200).json({ nonce, expiresAt, messageToSign });
  } catch (error) {
    console.error('Error generating nonce:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ------------------------------------------------------
//  POST /auth/wallet-login
//  Verifies signature over server-canonical messageToSign,
//  then consumes nonce (single-use).
//  Also receives sparkAddress and stores encrypted payout destination fields.
// ------------------------------------------------------
router.post('/auth/wallet-login', async (req, res) => {
  try {
    const { pubkey, nonce, signature, iat, sparkAddress } = req.body || {};

    // 🔎 DEBUG: log what actually arrived over the wire (no base64 guessing)
    const sigStr = String(signature ?? '');
    const sigTrim = sigStr.trim();
    const sigBuf = sessionHelper.decodeHexStrict ? sessionHelper.decodeHexStrict(sigTrim) : null;

    const errors = [];
    if (!pubkey || typeof pubkey !== 'string') errors.push('pubkey is required');
    if (!nonce || typeof nonce !== 'string') errors.push('nonce is required');
    if (!signature || typeof signature !== 'string') errors.push('signature is required');
    if (iat !== undefined && iat !== null && Number.isNaN(Number(iat))) errors.push('iat must be a number if provided');

    // sparkAddress is required in your new flow (since iOS now always fetches it).
    // If you want a gradual rollout, change this to optional.
    if (!sparkAddress || typeof sparkAddress !== 'string') errors.push('sparkAddress is required');

    // Minimal sanity check — avoids storing obviously bogus values.
    // Keep this loose to avoid false negatives across prefixes/networks.
    if (typeof sparkAddress === 'string') {
      const addr = sparkAddress.trim();
      if (addr.length < 10 || addr.length > 200) errors.push('sparkAddress looks invalid');
      // Optional: basic bech32-ish shape (lowercase + "1" separator)
      // Comment out if you want absolutely no constraints.
      if (!/[a-z0-9]+1[a-z0-9]+/.test(addr)) errors.push('sparkAddress format is invalid');
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const sparkAddrTrim = String(sparkAddress).trim();
    let walletPrivacyFields;
    try {
      walletPrivacyFields = buildUserPrivacyFields({
        walletPubkey: pubkey,
      }, {
        requirePepper: true,
      });
    } catch (error) {
      console.error('Wallet login privacy configuration error:', error.message);
      return res.status(500).json({ error: 'User privacy configuration is missing' });
    }

    // ✅ Check nonce without consuming it yet
    const nonceRecord = sessionHelper.peekNonce(nonce, {
      purpose: sessionHelper.WALLET_AUTH_PURPOSE,
    });
    if (!nonceRecord) {
      return res.status(401).json({ error: 'Invalid or expired nonce' });
    }

    const { messageToSign } = nonceRecord;

    // ✅ Verify signature over the canonical server message
    let isValid = false;
    try {
      isValid = sessionHelper.verifyBreezSignedMessage({
        message: messageToSign,
        pubkey,
        signature,
      });
    } catch (e) {
      console.error('Signature verify error:', e);
      return res.status(500).json({
        error: 'Signature verification unavailable',
        details: String(e.message || e),
      });
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ✅ Consume nonce only after successful verification
    sessionHelper.consumeNonce(nonce, {
      purpose: sessionHelper.WALLET_AUTH_PURPOSE,
    });

    // ✅ Find or create user, and backfill payout destination privacy fields.
    let user = await User.findOne({
      walletPubkeyUserHmac: walletPrivacyFields.walletPubkeyUserHmac,
    });

    if (!user) {
      const sparkPrivacyFields = buildUserPrivacyFields({
        sparkAddress: sparkAddrTrim,
      });
      const sparkEncryptionFields = buildSparkAddressEncryptionFields(sparkAddrTrim);

      user = await User.create({
        ...walletPrivacyFields,
        ...sparkPrivacyFields,
        ...sparkEncryptionFields,
      });
      console.log('New Wallet Linked');
    } else {
      let didMutateUser = false;

      for (const [key, value] of Object.entries(walletPrivacyFields)) {
        if (user[key] !== value) {
          user[key] = value;
          didMutateUser = true;
        }
      }

      const payoutSparkAddress = resolvePayoutSparkAddressForLogin(user, sparkAddrTrim);
      if (payoutSparkAddress !== sparkAddrTrim) {
        console.warn('sparkAddress mismatch for wallet user; keeping stored payout destination', {
          userId: String(user._id),
          walletPubkeyUserHmac: user.walletPubkeyUserHmac || walletPrivacyFields.walletPubkeyUserHmac || null,
          hasStoredSparkAddress: true,
          hasIncomingSparkAddress: true,
        });
      }

      const sparkPrivacyFields = buildUserPrivacyFields({
        sparkAddress: payoutSparkAddress,
      });
      for (const [key, value] of Object.entries(sparkPrivacyFields)) {
        if (user[key] !== value) {
          user[key] = value;
          didMutateUser = true;
        }
      }

      if (!hasCurrentSparkAddressEncryptionFields(user) && payoutSparkAddress) {
        const sparkEncryptionFields = buildSparkAddressEncryptionFields(payoutSparkAddress);
        for (const [key, value] of Object.entries(sparkEncryptionFields)) {
          user[key] = value;
        }
        didMutateUser = true;
      }

      if (didMutateUser) {
        await user.save();
      }
    }

    // Mint 1-hour JWT cookie
    const token = jwt.sign(
      { userId: String(user._id) },
      getJwtSecretKey(),
      { expiresIn: '1h' }
    );

    res.cookie('jwtToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000,
    });

    return res.status(200).json({
      ok: true,
      userId: String(user._id),
    });
  } catch (error) {
    if (error?.publicMessage) {
      return res.status(error.statusCode || 500).json({ error: error.publicMessage });
    }

    console.error('Error in wallet-login:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ------------------------------------------------------
//  GET /session
// ------------------------------------------------------
router.get('/session', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      ok: true,
      userId: String(user._id),
    });
  } catch (error) {
    console.error('Error checking session:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/Profile_Pic', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select('_id profilePicUrl');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      profilePicUrl: user.profilePicUrl || null,
    });
  } catch (error) {
    console.error('Error fetching profile picture:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/Upload_Profile_Pic', userAuthMiddleware, upload.single('profilePic'), async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'profilePic file is required' });
    }

    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'profilePic must be an image file' });
    }

    if (user.profilePicUrl) {
      await deleteProfilePictureFromR2(user.profilePicUrl);
    }

    const fileName = `${crypto.randomUUID()}.png`;

    const resizedBuffer = await sharp(file.buffer)
      .rotate()
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .png()
      .toBuffer();

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: resizedBuffer,
      ContentType: 'image/png',
      ACL: 'public-read',
    }));

    const publicUrl = `https://cdn.example.invalid/${fileName}`;
    user.profilePicUrl = publicUrl;
    await user.save();

    return res.status(200).json({
      ok: true,
      profilePicUrl: user.profilePicUrl,
    });
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/v1/reward-claim-encryption-key', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(rewardClaimEncryption.publicKeyResponse());
  } catch (error) {
    console.error('Reward claim encryption key error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/v2/reward-spend-claims', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = rewardClaimEncryption.decryptClaimEnvelope(req.body || {});
    } catch (error) {
      return res.status(400).json({ ok: false, error: 'Invalid encrypted reward claim' });
    }

    const merchantPubkeyHash = normalizeHash(payload.merchantPubkeyHash);
    const paymentHashProof = normalizeProof32ByteHex(payload.paymentHash);
    const preimageProof = normalizeProof32ByteHex(payload.preimage);
    const paymentHash = paymentHashProof?.hex || '';
    const preimage = preimageProof?.hex || '';
    const invoice = String(payload.invoice || '').trim();
    const btcAmountSatsNum = Number(payload.btcAmountSats);
    const usdAmountCentsNum = Number(payload.usdAmountCents);
    const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();
    const errors = [];

    if (!merchantPubkeyHash) errors.push('merchantPubkeyHash is required');
    if (!paymentHashProof) errors.push('paymentHash must be a 32-byte hex or base64 value');
    if (!preimageProof) errors.push('preimage must be a 32-byte hex or base64 value');
    if (!invoice) errors.push('invoice is required');
    if (!Number.isInteger(btcAmountSatsNum) || btcAmountSatsNum <= 0) {
      errors.push('btcAmountSats must be a positive integer');
    }
    if (!Number.isFinite(usdAmountCentsNum) || usdAmountCentsNum <= 0) {
      errors.push('usdAmountCents must be a positive number');
    }
    if (Number.isNaN(occurredAt.getTime())) errors.push('occurredAt must be a valid date');

    if (errors.length > 0) {
      return res.status(400).json({ ok: false, error: 'Invalid request', details: errors });
    }

    const paymentHashFromPreimage = sha256Hex(Buffer.from(preimage, 'hex'));
    if (paymentHashFromPreimage !== paymentHash) {
      return res.status(400).json({ ok: false, error: 'preimage does not match paymentHash' });
    }

    const invoiceMetadata = decodeBolt11(invoice);
    if (!invoiceMetadata?.paymentHash || !invoiceMetadata?.destinationPubkey) {
      return res.status(400).json({ ok: false, error: 'invoice could not be verified' });
    }

    if (normalizeHash(invoiceMetadata.paymentHash) !== paymentHash) {
      return res.status(400).json({ ok: false, error: 'invoice paymentHash mismatch' });
    }

    const invoiceMerchantHash = MerchantPubKey.hashPubkey(invoiceMetadata.destinationPubkey);
    if (invoiceMerchantHash !== merchantPubkeyHash) {
      return res.status(400).json({ ok: false, error: 'invoice destination is not the claimed merchant' });
    }

    if (
      Number.isInteger(invoiceMetadata.amountSats) &&
      invoiceMetadata.amountSats > 0 &&
      invoiceMetadata.amountSats !== btcAmountSatsNum
    ) {
      return res.status(400).json({ ok: false, error: 'invoice amount mismatch' });
    }

    const merchantPubkeyMatch = await MerchantPubKey.findOne({
      pubkeyHash: merchantPubkeyHash,
      pubkeyHashVersion: MerchantPubKey.PUBKEY_HASH_VERSION,
    }).select('_id').lean();

    if (!merchantPubkeyMatch) {
      return res.status(400).json({ ok: false, error: 'merchant is not reward eligible' });
    }

    const monthKey = occurredAt.toISOString().slice(0, 7);
    const paymentHashHash = sha256Hex(Buffer.from(paymentHash, 'utf8'));
    const invoiceHash = sha256Hex(Buffer.from(invoice, 'utf8'));

    try {
      await RewardSpendPayment.create({
        userId,
        paymentHashHash,
        invoiceHash,
        merchantPubkeyHash,
        btcAmountSats: btcAmountSatsNum,
        usdAmountCents: usdAmountCentsNum,
        network: 'lightning',
        direction: 'sent',
        status: 'Completed',
        monthKey,
        occurredAt,
        verificationMethod: 'encrypted-bolt11-preimage-v1',
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(200).json({
          ok: true,
          rewardSpendApplied: false,
          duplicatePaymentHash: true,
        });
      }

      throw error;
    }

    await PlatformAnalytics.updateOne(
      { _id: 'platform' },
      {
        $inc: {
          transactions: 1,
          'transactionVolume.btcSats': btcAmountSatsNum,
          'transactionVolume.usdCents': usdAmountCentsNum,
          merchantTransactions: 1,
          'merchantVolume.btcSats': btcAmountSatsNum,
          'merchantVolume.usdCents': usdAmountCentsNum,
        },
      },
      { upsert: true }
    );

    return res.status(200).json({
      ok: true,
      rewardSpendApplied: true,
      merchantMatched: true,
      rewardSpendPaymentRecorded: true,
      duplicatePaymentHash: false,
    });
  } catch (error) {
    console.error('Encrypted reward claim error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/ReportMerchantPubkey', userAuthMiddleware, async (req, res) => {
  try {
    const {
      merchantName,
      merchantAddress,
      destinationPubkey,
    } = req.body || {};

    const trimmedMerchantName = String(merchantName || '').trim();
    const trimmedMerchantAddress = String(merchantAddress || '').trim();
    const trimmedDestinationPubkey = normalizePubkey(destinationPubkey);

    if (!trimmedMerchantName || !trimmedMerchantAddress || !trimmedDestinationPubkey) {
      return res.status(400).json({
        ok: false,
        error: 'merchantName, merchantAddress, and destinationPubkey are required',
      });
    }

    const reporter = await User.findById(req.userId)
      .select('walletPubkeyUserHmac')
      .lean();
    const merchantPubkeyMatch = await MerchantPubKey.findOne(merchantPubkeyQuery(trimmedDestinationPubkey))
      .select('_id')
      .lean();

    console.log('=== MERCHANT PUBKEY REPORT START ===');
    console.log(
      JSON.stringify(
        {
          reportedAt: new Date().toISOString(),
          reporterUserId: req.userId,
          reporterWalletPubkeyHmac: reporter?.walletPubkeyUserHmac || null,
          merchantName: trimmedMerchantName,
          merchantAddress: trimmedMerchantAddress,
          destinationPubkey: trimmedDestinationPubkey,
          merchantPubkeyDatabaseMatch: merchantPubkeyMatch ? 'positive' : 'negative',
        },
        null,
        2
      )
    );
    console.log('=== MERCHANT PUBKEY REPORT END ===');

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Merchant pubkey report error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /RewardStats
router.get('/v1/RewardStats', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // Auth guard: ensure user from JWT exists
    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Current monthKey in UTC (YYYY-MM)
    const monthKey = new Date().toISOString().slice(0, 7);

    // -----------------------------
    // 1) Fetch monthly pot (platform wallet balance) FROM DB
    // -----------------------------
    const platformWallet = await PlatformWallet.findOne({})
      .select('balanceSats')
      .lean();

    if (!platformWallet) {
      return res.status(500).json({ error: 'PlatformWallet not found' });
    }

    const potSats = Number(platformWallet.balanceSats ?? 0);

    if (!Number.isInteger(potSats) || potSats < 0) {
      return res.status(500).json({
        error: 'Invalid PlatformWallet.balanceSats in database',
        details: { balanceSats: platformWallet.balanceSats },
      });
    }

    // -----------------------------
    // 2) Platform reward-eligible payment totals for month
    // -----------------------------
    const platformAgg = await RewardSpendPayment.aggregate([
      { $match: { monthKey } },
      {
        $group: {
          _id: '$monthKey',
          rewardSpendCents: { $sum: '$usdAmountCents' },
          transactions: { $sum: 1 },
        },
      },
    ]);

    const platformRewardSpendCents = Number(platformAgg?.[0]?.rewardSpendCents ?? 0);
    const platformTransactions = Number(platformAgg?.[0]?.transactions ?? 0);

    // -----------------------------
    // 3) User reward-eligible payment totals for month
    // -----------------------------
    const userAgg = await RewardSpendPayment.aggregate([
      {
        $match: {
          monthKey,
          userId: new mongoose.Types.ObjectId(userId),
        },
      },
      {
        $group: {
          _id: '$userId',
          rewardSpendCents: { $sum: '$usdAmountCents' },
          transactions: { $sum: 1 },
        },
      },
    ]);

    const userRewardSpendCents = Number(userAgg?.[0]?.rewardSpendCents ?? 0);
    const userTransactions = Number(userAgg?.[0]?.transactions ?? 0);

    // -----------------------------
    // 4) Share % + projected earnings (no rank)
    // -----------------------------
    let shareBps = 0; // basis points: 100 = 1.00%
    let projectedEarningsSats = 0;

    if (platformRewardSpendCents > 0 && userRewardSpendCents > 0) {
      // Share in basis points (floored)
      shareBps = Math.floor((userRewardSpendCents * 10000) / platformRewardSpendCents);

      // Projected earnings sats using integer math (floored)
      const pot = BigInt(potSats);
      const userSpend = BigInt(userRewardSpendCents);
      const platformSpend = BigInt(platformRewardSpendCents);

      projectedEarningsSats = Number((pot * userSpend) / platformSpend);
    } else {
      shareBps = 0;
      projectedEarningsSats = 0;
    }

    // -----------------------------
    // 5) Lifetime earnings from paid payout allocations
    // -----------------------------
    const lifetimeAgg = await RewardPayoutAllocation.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          paid: true,
        },
      },
      {
        $group: {
          _id: null,
          lifetimeEarningsSats: { $sum: '$rewardSats' },
        },
      },
    ]);

    const lifetimeEarningsSats = Number(lifetimeAgg?.[0]?.lifetimeEarningsSats ?? 0);

    return res.status(200).json({
      monthKey,
      monthlyPot: { sats: potSats },
      platform: {
        rewardSpendCents: platformRewardSpendCents,
        transactions: platformTransactions,
      },
      user: {
        rewardSpendCents: userRewardSpendCents,
        transactions: userTransactions,
      },
      stats: {
        shareBps,
        projectedEarningsSats,
        lifetimeEarningsSats, // NEW
      },
    });
  } catch (err) {
    console.error('Error in /RewardStats:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function issueAccountDeleteNonce(req, res) {
  try {
    const user = await User.findById(req.userId).select('_id');
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const domain = process.env.WALLET_AUTH_DOMAIN || 'example.invalid';
    const { nonce, expiresAt, messageToSign, purpose } = sessionHelper.issueNonce({
      domain,
      purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
    });

    return res.status(200).json({
      ok: true,
      nonce,
      expiresAt,
      messageToSign,
      purpose,
    });
  } catch (error) {
    console.error('Error generating account delete nonce:', error);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}

function normalizeAccountDeleteProofPayload(payload = {}) {
  const rawWalletPubkey = payload.walletPubkey ?? payload.pubkey;
  const walletPubkey = normalizeWalletPubkey(rawWalletPubkey);
  const nonce = typeof payload.nonce === 'string' ? payload.nonce.trim() : '';
  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  const errors = [];

  if (!walletPubkey) errors.push('walletPubkey is required or invalid');
  if (!nonce) errors.push('nonce is required');
  if (!signature) errors.push('signature is required');

  return {
    errors,
    walletPubkey,
    nonce,
    signature,
  };
}

async function deleteAuthenticatedAccountV2(req, res) {
  try {
    const userId = req.userId;
    const user = await User.findById(userId).select('_id walletPubkeyUserHmac profilePicUrl');
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const proof = normalizeAccountDeleteProofPayload(req.body || {});
    if (proof.errors.length) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request',
        details: proof.errors,
      });
    }

    const nonceRecord = sessionHelper.peekNonce(proof.nonce, {
      purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
    });
    if (!nonceRecord) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired nonce' });
    }

    const isValidSignature = sessionHelper.verifyBreezSignedMessage({
      message: nonceRecord.messageToSign,
      pubkey: proof.walletPubkey,
      signature: proof.signature,
    });
    if (!isValidSignature) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    let walletPrivacyFields;
    try {
      walletPrivacyFields = buildUserPrivacyFields({
        walletPubkey: proof.walletPubkey,
      }, {
        requirePepper: true,
      });
    } catch (error) {
      console.error('Account delete privacy configuration error:', error.message);
      return res.status(500).json({ ok: false, error: 'User privacy configuration is missing' });
    }

    if (!user.walletPubkeyUserHmac) {
      return res.status(409).json({
        ok: false,
        error: 'User wallet privacy identity is missing',
      });
    }

    if (user.walletPubkeyUserHmac !== walletPrivacyFields.walletPubkeyUserHmac) {
      return res.status(403).json({
        ok: false,
        error: 'walletPubkey does not match the authenticated user',
      });
    }

    sessionHelper.consumeNonce(proof.nonce, {
      purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
    });

    const [profilePicDeleted, messagingV4Deleted] = await Promise.all([
      deleteProfilePictureFromR2(user.profilePicUrl),
      deleteMessagingV4AccountDataForWalletPubkey(proof.walletPubkey),
    ]);

    await user.deleteOne();

    res.clearCookie('jwtToken');

    return res.status(200).json({
      ok: true,
      message: 'Account deleted successfully',
      deleted: {
        user: true,
        profilePic: profilePicDeleted,
        v4MessagingAccount: messagingV4Deleted?.account || 0,
        v4MessagingBindings: messagingV4Deleted?.bindings || 0,
        v4DeviceRegistrations: messagingV4Deleted?.deviceRegistrations || 0,
        v4UserBlocks: messagingV4Deleted?.userBlocks || 0,
        v4DirectMessages: messagingV4Deleted?.directMessages || 0,
        v4Attachments: messagingV4Deleted?.attachments || 0,
        v4AttachmentObjectsDeleted: messagingV4Deleted?.attachmentObjectsDeleted || 0,
      },
    });
  } catch (err) {
    console.error('Error in signed delete account endpoint:', err);
    return res.status(500).json({ ok: false, error: 'An error occurred while processing the request' });
  }
}

router.post('/v2/account/delete/nonce', userAuthMiddleware, issueAccountDeleteNonce);
router.post('/v2/account/delete', userAuthMiddleware, deleteAuthenticatedAccountV2);

router.getRewardsMinimumVersion = getRewardsMinimumVersion;
router.rewardsMinimumVersions = rewardsMinimumVersions;

module.exports = router;
