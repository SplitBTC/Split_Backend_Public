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
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const MessagingDeviceRegistration = require('../models/MessagingDeviceRegistration');
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
const UserBlock = require('../models/UserBlock');
const userAuthMiddleware = require('../middlewares/userAuthMiddleware');
const userRewardSpendFunction = require('../rewards/userRewardSpendFunction');
const rewardClaimEncryption = require('../rewards/rewardClaimEncryption');
const { decodeBolt11 } = require('../rewards/bolt11Invoice');
const { normalizeProof32ByteHex } = require('../rewards/rewardProofEncoding');
const sessionHelper = require('../auth/sessionHelper');
const googleMapsAddressValidation = require('../services/googleMapsAddressValidation');
const {
  assignUserPrivacyFields,
  buildUserPrivacyFields,
} = require('../services/userPrivacy');
const {
  messagingDataHmac,
  normalizeWalletPubkey,
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

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rewardTraceFingerprint(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'none';
  return sha256Hex(Buffer.from(value.trim(), 'utf8')).slice(0, 12);
}

function rewardClaimTrace(event, details = {}) {
  console.info(
    '[RewardClaimTrace]',
    event,
    JSON.stringify(details)
  );
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

async function deleteMessagingV4AccountDataForUser(user, req) {
  const walletPubkey = normalizeWalletPubkey(req.pubkey || user.walletPubkey);
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
  ios: '4.3.1',
  android: '0.6.1',
});
const MILES_TO_METERS = 1609.344;
const COUPON_DEFAULT_RADIUS_MILES = 25;
const COUPON_MAX_RADIUS_MILES = 50;
const COUPON_DEFAULT_LIMIT = 50;
const COUPON_MAX_LIMIT = 100;

function getRewardsMinimumVersion(platform) {
  const requestedPlatform = String(platform || '').trim().toLowerCase();

  // Keep missing platform mapped to iOS so already-released iOS builds
  // continue receiving the correct minimum version until they start
  // sending platform=ios explicitly.
  return requestedPlatform === 'android'
    ? rewardsMinimumVersions.android
    : rewardsMinimumVersions.ios;
}

function parseCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCouponRadiusMiles(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return COUPON_DEFAULT_RADIUS_MILES;
  }

  return Math.max(1, Math.min(COUPON_MAX_RADIUS_MILES, parsed));
}

function normalizePostalCode(value) {
  const digits = String(value || '').trim().replace(/[^\d]/g, '');

  if (digits.length === 9) {
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }

  if (digits.length === 5) {
    return digits;
  }

  return String(value || '').trim();
}

function getCurrentCouponRedemptionMonth(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function readCookieValue(req, name) {
  if (req?.cookies && typeof req.cookies[name] === 'string') {
    return req.cookies[name];
  }

  const rawCookieHeader = String(req?.headers?.cookie || '');
  if (!rawCookieHeader) {
    return null;
  }

  const cookies = rawCookieHeader.split(';');
  for (const cookie of cookies) {
    const trimmedCookie = cookie.trim();
    if (!trimmedCookie) {
      continue;
    }

    const separatorIndex = trimmedCookie.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedCookie.slice(0, separatorIndex).trim();
    if (key !== name) {
      continue;
    }

    return decodeURIComponent(trimmedCookie.slice(separatorIndex + 1).trim());
  }

  return null;
}

function getOptionalAuthenticatedUserId(req) {
  const secretKey = getJwtSecretKey();
  if (!secretKey) {
    return null;
  }

  const token = readCookieValue(req, 'jwtToken');
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, secretKey);
    return decoded?.userId ? String(decoded.userId) : null;
  } catch (_error) {
    return null;
  }
}

function isDuplicateKeyError(error) {
  return !!error && error.code === 11000;
}

function isMongooseCastError(error) {
  return error instanceof mongoose.Error.CastError || error?.name === 'CastError';
}

function buildNearbyCouponPipeline({ latitude, longitude, radiusMiles, limit }) {
  return [
    {
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
        distanceField: 'distanceMeters',
        maxDistance: radiusMiles * MILES_TO_METERS,
        query: {
          status: 'approved',
        },
        spherical: true,
      },
    },
    {
      $sort: {
        distanceMeters: 1,
        createdAt: -1,
      },
    },
    {
      $limit: limit,
    },
    {
      $project: {
        businessName: 1,
        businessLogoUrl: 1,
        dealDescription: 1,
        appliesToAllLocations: 1,
        primaryBusinessAddress: 1,
        distanceMeters: 1,
      },
    },
  ];
}

function serializePublicCoupon(coupon, options = {}) {
  const redemption = options.redemption || null;
  const distanceMeters = Number(coupon?.distanceMeters);
  const distanceMiles = Number.isFinite(distanceMeters)
    ? Math.round((distanceMeters / MILES_TO_METERS) * 100) / 100
    : null;

  return {
    id: String(coupon?._id || ''),
    businessName: String(coupon?.businessName || '').trim(),
    businessLogoUrl: String(coupon?.businessLogoUrl || '').trim() || null,
    dealDescription: String(coupon?.dealDescription || '').trim(),
    appliesToAllLocations: !!coupon?.appliesToAllLocations,
    hasRedeemedThisMonth: !!redemption,
    currentUserRedeemedAt: redemption?.redeemedAt || null,
    primaryBusinessAddress: coupon?.primaryBusinessAddress
      ? {
          formattedAddress: String(coupon.primaryBusinessAddress.formattedAddress || '').trim(),
          line1: String(coupon.primaryBusinessAddress.line1 || '').trim(),
          line2: String(coupon.primaryBusinessAddress.line2 || '').trim(),
          city: String(coupon.primaryBusinessAddress.city || '').trim(),
          state: String(coupon.primaryBusinessAddress.state || '').trim(),
          postalCode: String(coupon.primaryBusinessAddress.postalCode || '').trim(),
          countryCode: String(coupon.primaryBusinessAddress.countryCode || '').trim(),
          placeId: String(coupon.primaryBusinessAddress.placeId || '').trim(),
          latitude: Number(coupon.primaryBusinessAddress.latitude),
          longitude: Number(coupon.primaryBusinessAddress.longitude),
        }
      : null,
    distanceMiles,
  };
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

router.get('/v1/merchant-coupons/nearby', async (req, res) => {
  try {
    const currentUserId = getOptionalAuthenticatedUserId(req);
    const latitude = parseCoordinate(req.query.latitude);
    const longitude = parseCoordinate(req.query.longitude);
    const postalCode = normalizePostalCode(req.query.postalCode);
    const radiusMiles = parseCouponRadiusMiles(req.query.radiusMiles);
    const requestedLimit = parsePositiveInteger(req.query.limit);
    const limit = requestedLimit
      ? Math.max(1, Math.min(COUPON_MAX_LIMIT, requestedLimit))
      : COUPON_DEFAULT_LIMIT;

    let searchOrigin = null;

    if (latitude !== null || longitude !== null) {
      if (latitude === null || longitude === null) {
        return res.status(400).json({
          error: 'latitude and longitude must be provided together',
        });
      }

      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res.status(400).json({
          error: 'latitude or longitude is out of range',
        });
      }

      searchOrigin = {
        source: 'device',
        latitude,
        longitude,
        postalCode: null,
        formattedAddress: null,
      };
    } else if (postalCode) {
      try {
        const resolvedOrigin = await googleMapsAddressValidation.resolveUsPostalCodeSearchOrigin(postalCode);
        searchOrigin = {
          source: 'postalCode',
          latitude: resolvedOrigin.latitude,
          longitude: resolvedOrigin.longitude,
          postalCode: resolvedOrigin.postalCode,
          formattedAddress: resolvedOrigin.formattedAddress,
        };
      } catch (error) {
        if (error instanceof googleMapsAddressValidation.AddressValidationError) {
          return res.status(400).json({ error: error.message });
        }

        console.error('Error resolving coupon ZIP code search origin:', error);
        return res.status(500).json({ error: 'Unable to resolve ZIP code right now' });
      }
    } else {
      return res.status(400).json({
        error: 'latitude and longitude or postalCode is required',
      });
    }

    const coupons = await Coupon.aggregate(
      buildNearbyCouponPipeline({
        latitude: searchOrigin.latitude,
        longitude: searchOrigin.longitude,
        radiusMiles,
        limit,
      })
    );

    let redemptionMap = new Map();
    if (currentUserId && coupons.length) {
      const couponIds = coupons
        .map((coupon) => coupon?._id)
        .filter(Boolean);

      if (couponIds.length) {
        const redemptions = await CouponRedemption.find({
          couponId: { $in: couponIds },
          userId: currentUserId,
          redemptionMonth: getCurrentCouponRedemptionMonth(),
        })
          .select('couponId redeemedAt')
          .lean();

        redemptionMap = new Map(
          redemptions.map((redemption) => [
            String(redemption.couponId),
            redemption,
          ])
        );
      }
    }

    return res.status(200).json({
      coupons: coupons.map((coupon) => serializePublicCoupon(coupon, {
        redemption: redemptionMap.get(String(coupon?._id)),
      })),
      searchOrigin,
      radiusMiles,
    });
  } catch (error) {
    console.error('Error fetching nearby merchant coupons:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/v1/merchant-coupons/:couponId/redeem', userAuthMiddleware, async (req, res) => {
  try {
    const couponId = String(req.params.couponId || '').trim();
    if (!couponId) {
      return res.status(400).json({ error: 'couponId is required' });
    }

    const coupon = await Coupon.findOne({
      _id: couponId,
      status: 'approved',
    }).select('_id');

    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found' });
    }

    const redemptionMonth = getCurrentCouponRedemptionMonth();
    const redeemedAt = new Date();

    try {
      const redemption = await CouponRedemption.create({
        couponId: coupon._id,
        userId: req.userId,
        redemptionMonth,
        redeemedAt,
      });

      return res.status(200).json({
        ok: true,
        didRedeem: true,
        alreadyRedeemedThisMonth: false,
        redemptionMonth,
        redeemedAt: redemption.redeemedAt,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const existingRedemption = await CouponRedemption.findOne({
        couponId: coupon._id,
        userId: req.userId,
        redemptionMonth,
      }).select('redeemedAt');

      return res.status(200).json({
        ok: true,
        didRedeem: false,
        alreadyRedeemedThisMonth: true,
        redemptionMonth,
        redeemedAt: existingRedemption?.redeemedAt || null,
      });
    }
  } catch (error) {
    if (isMongooseCastError(error)) {
      return res.status(400).json({ error: 'Invalid coupon id' });
    }

    console.error('Error redeeming merchant coupon:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
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
//  Also receives sparkAddress and stores it on the user.
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
    const userPrivacyFields = buildUserPrivacyFields({
      walletPubkey: pubkey,
      sparkAddress: sparkAddrTrim,
    });

    // ✅ Check nonce without consuming it yet
    const nonceRecord = sessionHelper.peekNonce(nonce);
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
    sessionHelper.consumeNonce(nonce);

    // ✅ Find or create user, and backfill sparkAddress if missing
    const userLookup = userPrivacyFields.walletPubkeyUserHmac
      ? {
          $or: [
            { walletPubkeyUserHmac: userPrivacyFields.walletPubkeyUserHmac },
            { walletPubkey: pubkey },
          ],
        }
      : { walletPubkey: pubkey };
    let user = await User.findOne(userLookup);

    if (!user) {
      user = await User.create({
        walletPubkey: pubkey,     // ✅ required field satisfied
        sparkAddress: sparkAddrTrim,
        ...userPrivacyFields,
      });
      console.log('New Wallet Linked');
    } else {
      let didMutateUser = false;

      for (const [key, value] of Object.entries(userPrivacyFields)) {
        if (user[key] !== value) {
          user[key] = value;
          didMutateUser = true;
        }
      }

      if (!user.sparkAddress) {
        // Only set if missing (do not overwrite existing)
        user.sparkAddress = sparkAddrTrim;
        didMutateUser = true;
      } else if (user.sparkAddress !== sparkAddrTrim) {
        // Skeptical safety: log divergence so you can investigate.
        // You might later decide to reject, rotate, or allow updates.
        console.warn('sparkAddress mismatch for pubkey:', pubkey, {
          existing: user.sparkAddress,
          incoming: sparkAddrTrim,
        });
      }

      if (didMutateUser) {
        await user.save();
      }
    }

    // Mint 1-hour JWT cookie
    const token = jwt.sign(
      { userId: String(user._id), pubkey: pubkey },
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
      pubkey: pubkey,
    });
  } catch (error) {
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

    const user = await User.findById(userId).select('_id walletPubkey');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      ok: true,
      userId: String(user._id),
      pubkey: user.walletPubkey,
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

router.post('/lightning-address', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { lightningAddress } = req.body || {};

    if (!lightningAddress || typeof lightningAddress !== 'string') {
      return res.status(400).json({ error: 'lightningAddress is required' });
    }

    const trimmedLightningAddress = lightningAddress.trim().toLowerCase();

    if (trimmedLightningAddress.length < 3 || trimmedLightningAddress.length > 320) {
      return res.status(400).json({ error: 'lightningAddress looks invalid' });
    }

    // basic sanity check for user@domain format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedLightningAddress)) {
      return res.status(400).json({ error: 'lightningAddress format is invalid' });
    }

    const user = await User.findById(userId).select(
      '_id lightningAddress lightningAddressUserHmac lightningAddressUserHmacVersion'
    );
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // no-op if already set
    if (user.lightningAddress) {
      const existingLightningPrivacyFields = buildUserPrivacyFields({
        lightningAddress: user.lightningAddress,
      });

      let didBackfillPrivacyFields = false;
      for (const [key, value] of Object.entries(existingLightningPrivacyFields)) {
        if (user[key] !== value) {
          user[key] = value;
          didBackfillPrivacyFields = true;
        }
      }

      if (didBackfillPrivacyFields) {
        await user.save();
      }

      return res.status(200).json({
        ok: true,
        didUpdate: false,
        lightningAddress: user.lightningAddress,
      });
    }

    user.lightningAddress = trimmedLightningAddress;
    assignUserPrivacyFields(user, {
      lightningAddress: trimmedLightningAddress,
    });
    await user.save();

    return res.status(200).json({
      ok: true,
      didUpdate: true,
      lightningAddress: user.lightningAddress,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'lightningAddress already exists on another user' });
    }

    console.error('Error saving lightningAddress:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/LogRewardSpend', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // Basic auth guard: user from JWT must exist
    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      direction,
      usdAmountCents,
      btcAmountSats,
      destinationPubkey,
      network,
      status,
      paymentHash,
    } = req.body || {};

    // ---- Basic validation (only what reward spend needs) ----
    const errors = [];

    if (!direction || !['sent', 'received'].includes(direction)) {
      errors.push('direction must be "sent" or "received"');
    }

    if (
      usdAmountCents === undefined ||
      usdAmountCents === null ||
      Number.isNaN(Number(usdAmountCents))
    ) {
      errors.push('usdAmountCents is required and must be a number');
    }

    if (
      btcAmountSats === undefined ||
      btcAmountSats === null ||
      Number.isNaN(Number(btcAmountSats))
    ) {
      errors.push('btcAmountSats is required and must be a number');
    }

    if (!network || !['lightning', 'onchain', 'swap'].includes(network)) {
      errors.push('network must be "lightning", "onchain", or "swap"');
    }

    const finalStatus = status || 'Completed';
    if (!['Pending', 'Completed', 'Failed'].includes(finalStatus)) {
      errors.push('status must be "Pending", "Completed", or "Failed"');
    }

    if (
      destinationPubkey !== undefined &&
      destinationPubkey !== null &&
      typeof destinationPubkey !== 'string'
    ) {
      errors.push('destinationPubkey must be a string if provided');
    }

    if (
      paymentHash !== undefined &&
      paymentHash !== null &&
      typeof paymentHash !== 'string'
    ) {
      errors.push('paymentHash must be a string if provided');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const usdAmountCentsNum = Number(usdAmountCents);
    const btcAmountSatsNum = Number(btcAmountSats);
    const normalizedPaymentHash =
      typeof paymentHash === 'string' && paymentHash.trim().length > 0
        ? paymentHash.trim()
        : null;
    const normalizedDestinationPubkey = normalizePubkey(destinationPubkey);

    if (!Number.isFinite(usdAmountCentsNum) || usdAmountCentsNum <= 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: ['usdAmountCents must be a positive number'],
      });
    }

    if (!Number.isInteger(btcAmountSatsNum) || btcAmountSatsNum <= 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: ['btcAmountSats must be a positive integer (sats)'],
      });
    }

    if (
      finalStatus === 'Completed' &&
      network === 'lightning' &&
      direction === 'sent' &&
      !normalizedPaymentHash
    ) {
      return res.status(400).json({
        error: 'Invalid request',
        details: ['paymentHash is required for completed lightning sends'],
      });
    }

    let rewardSpendResult = null;

    // Only apply reward spend when status is Completed.
    if (finalStatus === 'Completed') {
      rewardSpendResult = await userRewardSpendFunction({
        User,
        RewardSpendPayment,
        MerchantPubKey,
        PlatformAnalytics,
        userId,
        usdAmountCentsNum,
        btcAmountSatsNum,
        destinationPubkey: normalizedDestinationPubkey || null,
        network,
        direction,
        finalStatus,
        paymentHash: normalizedPaymentHash,
      });
    }

    const rewardSpendApplied = Boolean(rewardSpendResult?.rewardSpendApplied);

    return res.status(200).json({
      ok: true,
      rewardSpendApplied,
      merchantMatched: rewardSpendResult?.merchantMatched ?? false,
      rewardSpendPaymentRecorded: rewardSpendResult?.rewardSpendPaymentRecorded ?? false,
      duplicatePaymentHash: rewardSpendResult?.duplicatePaymentHash ?? false,
    });
  } catch (error) {
    console.error('Error logging reward spend:', error);
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
    const claimId = typeof req.body?.clientClaimId === 'string'
      ? req.body.clientClaimId.trim().slice(0, 36)
      : 'none';
    rewardClaimTrace('start', {
      claimId,
      userFp: rewardTraceFingerprint(String(userId || '')),
      keyId: typeof req.body?.keyId === 'string' ? req.body.keyId.trim() : 'none',
      algorithm: typeof req.body?.algorithm === 'string' ? req.body.algorithm.trim() : 'none',
    });

    const user = await User.findById(userId).select('_id');
    if (!user) {
      rewardClaimTrace('reject unauthorized-user', { claimId });
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = rewardClaimEncryption.decryptClaimEnvelope(req.body || {});
    } catch (error) {
      rewardClaimTrace('reject decrypt-failed', {
        claimId,
        errorName: error?.name || 'Error',
      });
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

    rewardClaimTrace('decrypted', {
      claimId,
      merchantHashFp: rewardTraceFingerprint(merchantPubkeyHash),
      paymentHashFp: rewardTraceFingerprint(paymentHash),
      paymentHashEncoding: paymentHashProof?.encoding || 'invalid',
      preimagePresent: preimage.length > 0,
      preimageEncoding: preimageProof?.encoding || 'invalid',
      invoicePresent: invoice.length > 0,
      invoiceLen: invoice.length,
      btcAmountSats: Number.isFinite(btcAmountSatsNum) ? btcAmountSatsNum : null,
      usdAmountCents: Number.isFinite(usdAmountCentsNum) ? usdAmountCentsNum : null,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? 'invalid' : occurredAt.toISOString(),
    });

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
      rewardClaimTrace('reject validation', { claimId, errors });
      return res.status(400).json({ ok: false, error: 'Invalid request', details: errors });
    }

    const paymentHashFromPreimage = sha256Hex(Buffer.from(preimage, 'hex'));
    if (paymentHashFromPreimage !== paymentHash) {
      rewardClaimTrace('reject preimage-mismatch', {
        claimId,
        paymentHashFp: rewardTraceFingerprint(paymentHash),
      });
      return res.status(400).json({ ok: false, error: 'preimage does not match paymentHash' });
    }
    rewardClaimTrace('preimage-verified', {
      claimId,
      paymentHashFp: rewardTraceFingerprint(paymentHash),
    });

    const invoiceMetadata = decodeBolt11(invoice);
    if (!invoiceMetadata?.paymentHash || !invoiceMetadata?.destinationPubkey) {
      rewardClaimTrace('reject invoice-unverified', {
        claimId,
        invoiceHashFp: rewardTraceFingerprint(invoice),
        hasInvoicePaymentHash: Boolean(invoiceMetadata?.paymentHash),
        hasInvoiceDestination: Boolean(invoiceMetadata?.destinationPubkey),
      });
      return res.status(400).json({ ok: false, error: 'invoice could not be verified' });
    }

    if (normalizeHash(invoiceMetadata.paymentHash) !== paymentHash) {
      rewardClaimTrace('reject invoice-payment-hash-mismatch', {
        claimId,
        paymentHashFp: rewardTraceFingerprint(paymentHash),
        invoicePaymentHashFp: rewardTraceFingerprint(normalizeHash(invoiceMetadata.paymentHash)),
      });
      return res.status(400).json({ ok: false, error: 'invoice paymentHash mismatch' });
    }

    const invoiceMerchantHash = MerchantPubKey.hashPubkey(invoiceMetadata.destinationPubkey);
    if (invoiceMerchantHash !== merchantPubkeyHash) {
      rewardClaimTrace('reject merchant-hash-mismatch', {
        claimId,
        claimedMerchantHashFp: rewardTraceFingerprint(merchantPubkeyHash),
        invoiceMerchantHashFp: rewardTraceFingerprint(invoiceMerchantHash),
      });
      return res.status(400).json({ ok: false, error: 'invoice destination is not the claimed merchant' });
    }

    if (
      Number.isInteger(invoiceMetadata.amountSats) &&
      invoiceMetadata.amountSats > 0 &&
      invoiceMetadata.amountSats !== btcAmountSatsNum
    ) {
      rewardClaimTrace('reject invoice-amount-mismatch', {
        claimId,
        invoiceAmountSats: invoiceMetadata.amountSats,
        claimedAmountSats: btcAmountSatsNum,
      });
      return res.status(400).json({ ok: false, error: 'invoice amount mismatch' });
    }
    rewardClaimTrace('invoice-verified', {
      claimId,
      merchantHashFp: rewardTraceFingerprint(merchantPubkeyHash),
      paymentHashFp: rewardTraceFingerprint(paymentHash),
      invoiceHashFp: rewardTraceFingerprint(invoice),
      invoiceAmountSats: Number.isInteger(invoiceMetadata.amountSats) ? invoiceMetadata.amountSats : null,
    });

    const merchantPubkeyMatch = await MerchantPubKey.findOne({
      pubkeyHash: merchantPubkeyHash,
      pubkeyHashVersion: MerchantPubKey.PUBKEY_HASH_VERSION,
    }).select('_id').lean();

    if (!merchantPubkeyMatch) {
      rewardClaimTrace('reject merchant-not-eligible', {
        claimId,
        merchantHashFp: rewardTraceFingerprint(merchantPubkeyHash),
      });
      return res.status(400).json({ ok: false, error: 'merchant is not reward eligible' });
    }
    rewardClaimTrace('merchant-found', {
      claimId,
      merchantHashFp: rewardTraceFingerprint(merchantPubkeyHash),
      merchantIdFp: rewardTraceFingerprint(String(merchantPubkeyMatch._id || '')),
    });

    const monthKey = occurredAt.toISOString().slice(0, 7);
    const paymentHashHash = sha256Hex(Buffer.from(paymentHash, 'utf8'));
    const invoiceHash = sha256Hex(Buffer.from(invoice, 'utf8'));
    rewardClaimTrace('create-payment-row', {
      claimId,
      monthKey,
      paymentHashHashFp: paymentHashHash.slice(0, 12),
      invoiceHashFp: invoiceHash.slice(0, 12),
      merchantHashFp: rewardTraceFingerprint(merchantPubkeyHash),
      btcAmountSats: btcAmountSatsNum,
      usdAmountCents: usdAmountCentsNum,
    });

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
        rewardClaimTrace('duplicate-payment-hash', {
          claimId,
          paymentHashHashFp: paymentHashHash.slice(0, 12),
          invoiceHashFp: invoiceHash.slice(0, 12),
          errorCode: error.code,
        });
        return res.status(200).json({
          ok: true,
          rewardSpendApplied: false,
          duplicatePaymentHash: true,
        });
      }

      throw error;
    }
    rewardClaimTrace('payment-row-created', {
      claimId,
      paymentHashHashFp: paymentHashHash.slice(0, 12),
      invoiceHashFp: invoiceHash.slice(0, 12),
    });

    await User.updateOne(
      { _id: userId },
      { $inc: { lifetimeMerchantSpendCents: usdAmountCentsNum } }
    );
    rewardClaimTrace('user-updated', {
      claimId,
      usdAmountCents: usdAmountCentsNum,
    });

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
    rewardClaimTrace('platform-updated', {
      claimId,
      btcAmountSats: btcAmountSatsNum,
      usdAmountCents: usdAmountCentsNum,
    });

    rewardClaimTrace('success', {
      claimId,
      rewardSpendApplied: true,
      duplicatePaymentHash: false,
    });
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
      .select('lightningAddress pubkey')
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
          reporterWalletPubkey: req.pubkey || reporter?.pubkey || null,
          reporterLightningAddress: reporter?.lightningAddress || null,
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

router.post('/RewardsCheck', userAuthMiddleware, async (req, res) => {
  try {
    const { destinationPubkey } = req.body || {};
    if (destinationPubkey !== undefined && destinationPubkey !== null && typeof destinationPubkey !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'destinationPubkey must be a string',
      });
    }

    const trimmedDestinationPubkey = normalizePubkey(destinationPubkey);

    if (!trimmedDestinationPubkey) {
      return res.status(400).json({
        ok: false,
        error: 'destinationPubkey is required',
      });
    }

    const merchantPubkeyMatch = await MerchantPubKey.findOne(merchantPubkeyQuery(trimmedDestinationPubkey))
      .select('_id')
      .lean();

    return res.status(200).json({
      ok: true,
      rewardEligible: !!merchantPubkeyMatch,
      merchantMatched: !!merchantPubkeyMatch,
    });
  } catch (error) {
    console.error('Rewards check error:', error);
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

async function deleteAuthenticatedAccount(req, res) {
  try {
    const userId = req.userId;
    const user = await User.findById(userId).select('_id walletPubkey profilePicUrl');
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const [
      deviceRegistrationResult,
      userBlockResult,
      profilePicDeleted,
      messagingV4Deleted,
    ] = await Promise.all([
      MessagingDeviceRegistration.deleteMany({ userId: user._id }),
      UserBlock.deleteMany({ blockerUserId: user._id }),
      deleteProfilePictureFromR2(user.profilePicUrl),
      deleteMessagingV4AccountDataForUser(user, req),
    ]);

    await user.deleteOne();

    res.clearCookie('jwtToken');

    return res.status(200).json({
      ok: true,
      message: 'Account deleted successfully',
      deleted: {
        user: true,
        profilePic: profilePicDeleted,
        deviceRegistrations: deviceRegistrationResult.deletedCount || 0,
        userBlocks: userBlockResult.deletedCount || 0,
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
    console.error('Error in delete account endpoint:', err);
    return res.status(500).json({ ok: false, error: 'An error occurred while processing the request' });
  }
}

router.post('/v1/account/delete', userAuthMiddleware, deleteAuthenticatedAccount);
router.post('/iOS-delete-account', userAuthMiddleware, deleteAuthenticatedAccount);

router.getRewardsMinimumVersion = getRewardsMinimumVersion;
router.rewardsMinimumVersions = rewardsMinimumVersions;

module.exports = router;
