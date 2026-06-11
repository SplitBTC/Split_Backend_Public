require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const User = require('../models/User');
const DirectMessageV4 = require('../models/DirectMessageV4');
const MessageAttachmentV4 = require('../models/MessageAttachmentV4');
const MessagingAccount = require('../models/MessagingAccount');
const MessagingBinding = require('../models/MessagingBinding');
const MessagingDeviceRegistrationV4 = require('../models/MessagingDeviceRegistrationV4');
const UserBlockV4 = require('../models/UserBlockV4');
const userAuthMiddleware = require('../middlewares/userAuthMiddleware');
const sessionHelper = require('../auth/sessionHelper');
const { sendSilentMessagePush } = require('../messaging/apnsSilentPush');
const { sendFcmSilentMessagePush } = require('../messaging/fcmSilentPush');
const s3Client = require('../integrations/r2');
const {
  LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME,
  decryptPushToken,
  encryptPushToken,
  messagingDataHmac,
  normalizeClientHash: normalizePrivacyClientHash,
  normalizeWalletPubkey: normalizePrivacyWalletPubkey,
  pushTokenLookupHmac,
  userDataHmac,
} = require('../services/privacyCrypto');
const {
  bindingMatchesStoredRecord,
  buildEncryptedMessagingBindingStorageFields,
  buildMessagingAccountHmacs,
  buildMessagingIdentityV4Message,
  buildMessagingPubkeyHmac,
  materializeMessagingBindingV4,
  normalizeAndValidateMessagingIdentityV4,
  stripMessagingBindingV4,
} = require('../services/messagingV4Identity');
const {
  buildMessagingDeviceRegistrationV4Message,
  normalizeAndValidateMessagingDeviceRegistrationV4,
  stripMessagingDeviceRegistrationV4,
} = require('../services/messagingV4DeviceRegistration');

const MESSAGE_TTL_HOURS = 24 * 14;
const ACTIONABLE_OUTGOING_MESSAGE_STATUSES = [
  'rekey_required',
  'same_key_retry_required',
  'failed_same_key',
  'undelivered',
];
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const AUTHENTICATED_WALLET_PUBKEY_HEADER = 'x-split-wallet-pubkey';
const attachmentUpload = multer({
  limits: {
    fileSize: ATTACHMENT_MAX_BYTES,
  },
});

function stripDirectMessageV4Payload(messageDoc) {
  return {
    messageId: String(messageDoc._id),
    clientMessageId: messageDoc.clientMessageId,
    senderMessagingAccountId: String(messageDoc.senderMessagingAccountId),
    senderMessagingPubkey: messageDoc.senderMessagingPubkey,
    recipientMessagingAccountId: String(messageDoc.recipientMessagingAccountId),
    recipientMessagingPubkey: messageDoc.recipientMessagingPubkey,
    messageType: messageDoc.messageType,
    envelopeVersion: messageDoc.envelopeVersion,
    ciphertext: messageDoc.ciphertext,
    nonce: messageDoc.nonce,
    senderEphemeralPubkey: messageDoc.senderEphemeralPubkey,
    status: messageDoc.status,
    sameKeyRetryCount: Number(messageDoc.sameKeyRetryCount || 0),
    createdAt: messageDoc.createdAt,
    createdAtClient: messageDoc.createdAtClient,
    expiresAt: messageDoc.expiresAt,
    deliveredAt: messageDoc.deliveredAt,
    rekeyRequiredAt: messageDoc.rekeyRequiredAt,
    sameKeyDecryptFailedAt: messageDoc.sameKeyDecryptFailedAt,
    failedAt: messageDoc.failedAt,
    expiredAt: messageDoc.expiredAt,
  };
}

function normalizeMessagingPubkey(value) {
  return String(value || '').trim();
}

function parseIntegerValue(value) {
  if (Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseClientTimestampMs(value) {
  const parsedInteger = parseIntegerValue(value);
  if (parsedInteger != null) {
    return parsedInteger;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsedDate = Date.parse(value.trim());
    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }
  }

  return null;
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === 'string' && mongoose.Types.ObjectId.isValid(entry))
    .map((entry) => entry.trim());
}

function buildAttachmentV4ObjectKey({ senderMessagingAccountId }) {
  const randomId = crypto.randomUUID();
  return `messaging-v4-attachments/${String(senderMessagingAccountId)}/${Date.now()}-${randomId}.bin`;
}

function stripAttachmentV4Payload(attachmentDoc) {
  return {
    attachmentId: String(attachmentDoc._id),
    sizeBytes: attachmentDoc.sizeBytes,
    uploadContentType: attachmentDoc.uploadContentType,
    status: attachmentDoc.status,
    linkedMessageId: attachmentDoc.linkedMessageId ? String(attachmentDoc.linkedMessageId) : null,
    receivedAt: attachmentDoc.receivedAt,
    deletedAt: attachmentDoc.deletedAt,
    expiresAt: attachmentDoc.expiresAt,
  };
}

function buildMessagingBlockError(blockState) {
  if (blockState.blockedByRequester) {
    return {
      status: 409,
      error: 'You have blocked this user',
    };
  }

  if (blockState.blockedByTarget) {
    return {
      status: 409,
      error: 'Recipient is unavailable',
    };
  }

  return null;
}

async function deleteMessagingAttachmentObjects(attachments) {
  for (const attachment of attachments) {
    if (!attachment.objectKey) {
      continue;
    }

    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: attachment.objectKey,
      }));
    } catch (deleteError) {
      console.warn('Failed to delete blocked messaging attachment object:', deleteError);
    }
  }
}

function normalizeMessagingEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return ['dev', 'prod'].includes(normalized)
    ? normalized
    : null;
}

function currentMessagingPushEnvironment() {
  const configured = normalizeMessagingEnvironment(process.env.MESSAGING_PUSH_ENV);
  if (configured) {
    return configured;
  }

  const gitBranch = String(process.env.RENDER_GIT_BRANCH || '').trim().toLowerCase();
  if (gitBranch) {
    return gitBranch === 'main'
      ? 'prod'
      : 'dev';
  }

  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    ? 'prod'
    : 'dev';
}

function bindingSignedAtSeconds(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

function isMessagingPrivacyConfigurationError(error) {
  return /MESSAGING_DATA_PEPPER|PUSH_TOKEN_LOOKUP_PEPPER|PUSH_TOKEN_ENCRYPTION_KEY|MESSAGING_BINDING_ENCRYPTION_KEY/
    .test(String(error?.message || error));
}

function verifyMessagingIdentityBindingV4(binding) {
  const canonicalMessage = buildMessagingIdentityV4Message({
    walletPubkey: binding.walletPubkey,
    lightningAddressHash: binding.lightningAddressHash,
    lightningAddressHashScheme: binding.lightningAddressHashScheme,
    messagingPubkey: binding.messagingPubkey,
    signedAt: binding.messagingIdentitySignedAt,
    version: binding.messagingIdentitySignatureVersion,
  });

  return sessionHelper.verifyBreezSignedMessage({
    message: canonicalMessage,
    pubkey: binding.walletPubkey,
    signature: binding.messagingIdentitySignature,
  });
}

function verifyMessagingDeviceRegistrationV4(registration) {
  const canonicalMessage = buildMessagingDeviceRegistrationV4Message({
    walletPubkey: registration.walletPubkey,
    messagingPubkey: registration.messagingPubkey,
    platform: registration.platform,
    environment: registration.environment,
    deviceToken: registration.deviceToken,
    signedAt: registration.registrationSignedAt,
    version: registration.registrationSignatureVersion,
  });

  return sessionHelper.verifyBreezSignedMessage({
    message: canonicalMessage,
    pubkey: registration.walletPubkey,
    signature: registration.registrationSignature,
  });
}

function messagingAuthFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function extractAuthenticatedWalletPubkeyCandidate(req, options = {}) {
  const candidates = [
    { source: 'explicit', value: options.walletPubkey },
    { source: 'header', value: req.get?.(AUTHENTICATED_WALLET_PUBKEY_HEADER) },
    { source: 'body.authenticatedWalletPubkey', value: req.body?.authenticatedWalletPubkey },
    { source: 'body.senderWalletPubkey', value: req.body?.senderWalletPubkey },
  ];

  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value.trim()) {
      return candidate;
    }
  }

  return null;
}

async function resolveAuthenticatedWalletPubkey(req, options = {}) {
  const candidate = extractAuthenticatedWalletPubkeyCandidate(req, options);
  if (!candidate) {
    return {
      error: {
        status: 400,
        error: 'authenticated walletPubkey is required',
      },
    };
  }

  const walletPubkey = normalizePrivacyWalletPubkey(candidate.value);
  if (!walletPubkey) {
    return {
      error: {
        status: 400,
        error: 'authenticated walletPubkey is invalid',
      },
    };
  }

  const user = await User.findById(req.userId).select('_id walletPubkeyUserHmac');
  if (!user) {
    return {
      error: {
        status: 401,
        error: 'Unauthorized',
      },
    };
  }

  if (!user.walletPubkeyUserHmac) {
    return {
      error: {
        status: 409,
        error: 'User wallet privacy identity is missing',
      },
    };
  }

  let walletPubkeyUserHmac;
  try {
    walletPubkeyUserHmac = userDataHmac(walletPubkey);
  } catch (error) {
    return {
      error: {
        status: 500,
        error: 'User privacy configuration is missing',
      },
    };
  }

  if (user.walletPubkeyUserHmac !== walletPubkeyUserHmac) {
    return {
      error: {
        status: 403,
        error: 'walletPubkey does not match the authenticated user',
      },
    };
  }

  return {
    walletPubkey,
    source: candidate.source,
  };
}

async function loadActiveMessagingBindingV4(account) {
  if (!account) return null;

  if (account.activeBindingId) {
    const binding = await MessagingBinding.findById(account.activeBindingId);
    if (binding && binding.active) {
      return materializeMessagingBindingV4(binding);
    }
  }

  const binding = await MessagingBinding.findOne({
    messagingAccountId: account._id,
    active: true,
  }).sort({ updatedAt: -1, createdAt: -1 });
  return materializeMessagingBindingV4(binding);
}

async function loadAuthenticatedMessagingIdentityV4(req, options = {}) {
  const resolvedWallet = await resolveAuthenticatedWalletPubkey(req, options);
  if (resolvedWallet.error) {
    return {
      error: resolvedWallet.error,
    };
  }

  const { walletPubkey } = resolvedWallet;
  const walletPubkeyMessagingHmac = messagingDataHmac(walletPubkey);
  const account = await MessagingAccount.findOne({ walletPubkeyMessagingHmac });
  if (!account) {
    return {
      walletPubkey,
      account: null,
      binding: null,
    };
  }

  return {
    walletPubkey,
    account,
    binding: await loadActiveMessagingBindingV4(account),
  };
}

async function findOrCreateMessagingAccountV4(binding) {
  const hmacs = buildMessagingAccountHmacs(binding);
  const [walletAccount, lightningAccount] = await Promise.all([
    MessagingAccount.findOne({
      walletPubkeyMessagingHmac: hmacs.walletPubkeyMessagingHmac,
    }),
    MessagingAccount.findOne({
      lightningAddressMessagingHmac: hmacs.lightningAddressMessagingHmac,
    }),
  ]);

  if (walletAccount && lightningAccount &&
      String(walletAccount._id) !== String(lightningAccount._id)) {
    return {
      error: {
        status: 409,
        error: 'walletPubkey and lightningAddressHash refer to different messaging accounts',
      },
    };
  }

  const account = walletAccount || lightningAccount;
  if (!account) {
    return {
      account: await MessagingAccount.create({
        ...hmacs,
      }),
    };
  }

  let didUpdate = false;
  for (const [key, value] of Object.entries(hmacs)) {
    if (account[key] !== value) {
      account[key] = value;
      didUpdate = true;
    }
  }

  if (didUpdate) {
    await account.save();
  }

  return { account };
}

function buildDirectoryV4Payload() {
  return {
    mode: 'backend-owned',
    proof: null,
    issuedAt: new Date().toISOString(),
  };
}

function stripUserBlockV4Payload(blockDoc) {
  return {
    blockId: String(blockDoc._id),
    blockedMessagingAccountId: String(blockDoc.blockedMessagingAccountId),
    createdAt: blockDoc.createdAt,
    updatedAt: blockDoc.updatedAt,
  };
}

async function resolveMessagingBlockTargetV4({ lightningAddressHash }) {
  const normalizedLightningAddressHash = normalizePrivacyClientHash(lightningAddressHash);
  if (!normalizedLightningAddressHash) {
    return {
      error: {
        status: 400,
        error: 'lightningAddressHash is required or invalid',
      },
    };
  }

  const blockedLightningAddressMessagingHmac = messagingDataHmac(normalizedLightningAddressHash);
  const target = await MessagingAccount.findOne({
    lightningAddressMessagingHmac: blockedLightningAddressMessagingHmac,
  });

  if (!target) {
    return {
      error: {
        status: 404,
        error: 'Block target not found',
      },
    };
  }

  return {
    target,
    lightningAddressHash: normalizedLightningAddressHash,
    blockedLightningAddressMessagingHmac,
  };
}

async function getMessagingBlockStateV4({ requesterMessagingAccountId, targetMessagingAccountId }) {
  const [requesterBlock, targetBlock] = await Promise.all([
    UserBlockV4.findOne({
      blockerMessagingAccountId: requesterMessagingAccountId,
      blockedMessagingAccountId: targetMessagingAccountId,
    }).select('_id'),
    UserBlockV4.findOne({
      blockerMessagingAccountId: targetMessagingAccountId,
      blockedMessagingAccountId: requesterMessagingAccountId,
    }).select('_id'),
  ]);

  return {
    blockedByRequester: !!requesterBlock,
    blockedByTarget: !!targetBlock,
  };
}

async function cleanupBlockedConversationRelayDataV4({
  blockerMessagingAccountId,
  blockedMessagingAccountId,
}) {
  const pendingMessages = await DirectMessageV4.find({
    $or: [
      {
        senderMessagingAccountId: blockedMessagingAccountId,
        recipientMessagingAccountId: blockerMessagingAccountId,
      },
      {
        senderMessagingAccountId: blockerMessagingAccountId,
        recipientMessagingAccountId: blockedMessagingAccountId,
      },
    ],
    status: 'pending',
  }).select('_id');

  if (!pendingMessages.length) {
    return;
  }

  const messageIds = pendingMessages.map((message) => message._id);
  const linkedAttachments = await MessageAttachmentV4.find({
    linkedMessageId: { $in: messageIds },
    status: 'linked',
  }).select('_id objectKey');

  if (linkedAttachments.length) {
    await deleteMessagingAttachmentObjects(linkedAttachments);
    await MessageAttachmentV4.deleteMany({
      _id: { $in: linkedAttachments.map((attachment) => attachment._id) },
    });
  }

  await DirectMessageV4.deleteMany({
    _id: { $in: messageIds },
  });
}

async function resolveVerifiedMessagingRecipientV4({
  senderAccount,
  recipientPayload,
}) {
  const recipientLightningAddressHash = normalizePrivacyClientHash(recipientPayload?.lightningAddressHash);
  const recipientLightningAddressHashScheme = typeof recipientPayload?.lightningAddressHashScheme === 'string'
    ? recipientPayload.lightningAddressHashScheme.trim()
    : '';

  if (!recipientLightningAddressHash) {
    return {
      error: {
        status: 400,
        error: 'recipient.lightningAddressHash is required or invalid',
      },
    };
  }

  if (recipientLightningAddressHashScheme !== LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME) {
    return {
      error: {
        status: 400,
        error: `recipient.lightningAddressHashScheme must be ${LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME}`,
      },
    };
  }

  const normalizedRecipient = normalizeAndValidateMessagingIdentityV4(recipientPayload || {});
  if (normalizedRecipient.errors.length) {
    return {
      error: {
        status: 400,
        error: 'Invalid recipient binding',
        details: normalizedRecipient.errors.map((entry) => `recipient.${entry}`),
      },
    };
  }

  const recipientBinding = normalizedRecipient.binding;
  if (recipientBinding.lightningAddressHash !== recipientLightningAddressHash) {
    return {
      error: {
        status: 409,
        error: 'Recipient binding does not match the requested Lightning address hash',
      },
    };
  }

  if (!verifyMessagingIdentityBindingV4(recipientBinding)) {
    return {
      error: {
        status: 401,
        error: 'Recipient messaging v4 binding is invalid',
      },
    };
  }

  const recipientLightningAddressMessagingHmac = messagingDataHmac(recipientLightningAddressHash);
  const recipientAccount = await MessagingAccount.findOne({
    lightningAddressMessagingHmac: recipientLightningAddressMessagingHmac,
  });
  if (!recipientAccount) {
    return {
      error: {
        status: 404,
        error: 'Recipient not found',
      },
    };
  }

  if (String(recipientAccount._id) === String(senderAccount._id)) {
    return {
      error: {
        status: 400,
        error: 'Cannot message yourself',
      },
    };
  }

  const blockError = buildMessagingBlockError(await getMessagingBlockStateV4({
    requesterMessagingAccountId: senderAccount._id,
    targetMessagingAccountId: recipientAccount._id,
  }));
  if (blockError) {
    return { error: blockError };
  }

  const activeRecipientBinding = await loadActiveMessagingBindingV4(recipientAccount);
  if (!activeRecipientBinding) {
    return {
      error: {
        status: 409,
        error: 'Recipient messaging v4 is not active',
      },
    };
  }

  if (!bindingMatchesStoredRecord(activeRecipientBinding, recipientBinding)) {
    return {
      error: {
        status: 409,
        error: 'Recipient messaging v4 binding is stale, resolve again',
      },
    };
  }

  return {
    recipientAccount,
    recipientBinding,
    activeRecipientBinding,
    recipientLightningAddressHash,
    recipientLightningAddressMessagingHmac,
  };
}

async function deleteStaleMessagingDeviceRegistrationsV4({ messagingAccountId, activeMessagingPubkey }) {
  const activeMessagingPubkeyHmac = buildMessagingPubkeyHmac(activeMessagingPubkey);
  if (!messagingAccountId || !activeMessagingPubkeyHmac) {
    return;
  }

  await MessagingDeviceRegistrationV4.deleteMany({
    messagingAccountId,
    messagingPubkeyHmac: { $ne: activeMessagingPubkeyHmac },
  });
}

function shouldDeleteMessagingDeviceRegistrationForPushResult({ platform, pushResult }) {
  if (!pushResult || pushResult.ok || pushResult.skipped) {
    return false;
  }

  const statusCode = Number(pushResult.statusCode || 0);
  if (platform === 'apns') {
    if (![400, 404, 410].includes(statusCode)) {
      return false;
    }

    let reason = '';
    try {
      const parsed = typeof pushResult.body === 'string'
        ? JSON.parse(pushResult.body)
        : pushResult.body;
      reason = String(parsed?.reason || '').trim();
    } catch (_error) {
      reason = '';
    }

    return ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason) ||
      statusCode === 410;
  }

  if (platform === 'fcm') {
    if (statusCode === 404) {
      return true;
    }

    const serializedBody = JSON.stringify(pushResult.body || {});
    return /UNREGISTERED|registration-token-not-registered|Requested entity was not found/i
      .test(`${serializedBody} ${pushResult.error || ''}`);
  }

  return false;
}

async function sendPushNotificationsForDirectMessageV4({ directMessage }) {
  return sendMessagingPushNotificationsV4({
    messagingAccountId: directMessage.recipientMessagingAccountId,
    messagingPubkeys: [directMessage.recipientMessagingPubkey],
    pushType: 'messaging.new_message',
    conversationId: String(directMessage.senderMessagingAccountId),
    messageId: String(directMessage._id),
  });
}

async function sendMessagingPushNotificationsV4({
  messagingAccountId,
  messagingPubkeys,
  pushType,
  conversationId,
  messageId,
}) {
  const activeEnvironment = currentMessagingPushEnvironment();
  const normalizedMessagingPubkeyHmacs = Array.isArray(messagingPubkeys)
    ? messagingPubkeys
      .map((value) => buildMessagingPubkeyHmac(value))
      .filter((value, index, array) => value && array.indexOf(value) === index)
    : [];

  const registrationFilter = {
    messagingAccountId,
    environment: activeEnvironment,
  };

  if (normalizedMessagingPubkeyHmacs.length) {
    registrationFilter.messagingPubkeyHmac = { $in: normalizedMessagingPubkeyHmacs };
  }

  const registrations = await MessagingDeviceRegistrationV4.find(registrationFilter)
    .select(
      '_id platform deviceTokenCiphertext deviceTokenIv deviceTokenAuthTag deviceTokenKeyVersion'
    );

  if (!registrations.length) {
    return { attemptedCount: 0, prunedCount: 0 };
  }

  const staleRegistrationIds = [];
  let attemptedCount = 0;

  for (const registration of registrations) {
    let deviceToken = null;
    try {
      deviceToken = decryptPushToken({
        deviceTokenCiphertext: registration.deviceTokenCiphertext,
        deviceTokenIv: registration.deviceTokenIv,
        deviceTokenAuthTag: registration.deviceTokenAuthTag,
      });
    } catch (decryptError) {
      console.warn('Failed to decrypt messaging v4 push token:', {
        registrationId: String(registration._id),
        platform: registration.platform,
        error: decryptError?.message || String(decryptError),
      });
      continue;
    }

    const pushPayload = {
      deviceToken,
      pushType,
      conversationId,
      messageId,
    };

    attemptedCount += 1;
    let pushResult = null;
    if (registration.platform === 'fcm') {
      pushResult = await sendFcmSilentMessagePush(pushPayload).catch((pushError) => {
        console.warn('Failed to send FCM silent v4 message push:', {
          registrationId: String(registration._id),
          error: pushError?.message || String(pushError),
        });
        return null;
      });
    } else {
      pushResult = await sendSilentMessagePush(pushPayload).catch((pushError) => {
        console.warn('Failed to send APNs silent v4 message push:', {
          registrationId: String(registration._id),
          error: pushError?.message || String(pushError),
        });
        return null;
      });
    }

    if (shouldDeleteMessagingDeviceRegistrationForPushResult({
      platform: registration.platform,
      pushResult,
    })) {
      staleRegistrationIds.push(registration._id);
    }
  }

  if (staleRegistrationIds.length) {
    await MessagingDeviceRegistrationV4.deleteMany({
      _id: { $in: staleRegistrationIds },
    });
  }

  return {
    attemptedCount,
    prunedCount: staleRegistrationIds.length,
  };
}

async function sendOutgoingStatusPushNotificationsV4({ directMessages }) {
  if (!Array.isArray(directMessages) || !directMessages.length) {
    return { attemptedCount: 0, prunedCount: 0 };
  }

  const dedupedMessages = [];
  const seenKeys = new Set();
  for (const directMessage of directMessages) {
    const dedupeKey = `${String(directMessage.senderMessagingAccountId)}:${String(directMessage.recipientMessagingAccountId)}`;
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    seenKeys.add(dedupeKey);
    dedupedMessages.push(directMessage);
  }

  const senderMessagingAccountIds = dedupedMessages
    .map((message) => String(message?.senderMessagingAccountId || '').trim())
    .filter((value, index, array) => value && array.indexOf(value) === index)
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));

  if (!senderMessagingAccountIds.length) {
    return { attemptedCount: 0, prunedCount: 0 };
  }

  const senderAccounts = await MessagingAccount.find({
    _id: { $in: senderMessagingAccountIds },
  })
    .select('_id activeBindingId')
    .lean();
  const senderAccountById = new Map(senderAccounts.map((account) => [String(account._id), account]));

  let attemptedCount = 0;
  let prunedCount = 0;

  for (const directMessage of dedupedMessages) {
    const senderAccount = senderAccountById.get(String(directMessage.senderMessagingAccountId));
    if (!senderAccount) {
      continue;
    }

    const activeSenderBinding = await loadActiveMessagingBindingV4(senderAccount);
    if (!activeSenderBinding?.messagingPubkey) {
      continue;
    }

    const result = await sendMessagingPushNotificationsV4({
      messagingAccountId: directMessage.senderMessagingAccountId,
      messagingPubkeys: [activeSenderBinding.messagingPubkey],
      pushType: 'messaging.outgoing_status',
      conversationId: String(directMessage.recipientMessagingAccountId),
      messageId: String(directMessage._id),
    });

    attemptedCount += result.attemptedCount || 0;
    prunedCount += result.prunedCount || 0;
  }

  return {
    attemptedCount,
    prunedCount,
  };
}

async function markPendingMessagesRekeyRequiredV4({
  recipientMessagingAccountId,
  acceptedRecipientMessagingPubkeys,
  objectIds = null,
}) {
  if (!recipientMessagingAccountId ||
      !Array.isArray(acceptedRecipientMessagingPubkeys) ||
      !acceptedRecipientMessagingPubkeys.length) {
    return {
      updatedCount: 0,
      resetAttachmentCount: 0,
    };
  }

  const pendingMessagesFilter = {
    recipientMessagingAccountId,
    recipientMessagingPubkey: { $in: acceptedRecipientMessagingPubkeys },
    status: 'pending',
  };

  if (Array.isArray(objectIds) && objectIds.length) {
    pendingMessagesFilter._id = { $in: objectIds };
  }

  const now = new Date();
  const pendingMessages = await DirectMessageV4.find(pendingMessagesFilter)
    .select('_id senderMessagingAccountId recipientMessagingAccountId');

  if (!pendingMessages.length) {
    return {
      updatedCount: 0,
      resetAttachmentCount: 0,
    };
  }

  const messageIdsToUpdate = pendingMessages.map((message) => message._id);
  const [messageUpdateResult, attachmentResetResult] = await Promise.all([
    DirectMessageV4.updateMany(
      {
        _id: { $in: messageIdsToUpdate },
        status: 'pending',
      },
      {
        $set: {
          status: 'rekey_required',
          rekeyRequiredAt: now,
        },
        $unset: {
          ciphertext: '',
          nonce: '',
          senderEphemeralPubkey: '',
        },
      }
    ),
    MessageAttachmentV4.updateMany(
      {
        linkedMessageId: { $in: messageIdsToUpdate },
        recipientMessagingAccountId,
        status: 'linked',
      },
      {
        $set: {
          status: 'uploaded',
        },
        $unset: {
          linkedMessageId: '',
          linkedClientMessageId: '',
        },
      },
    ),
  ]);

  void sendOutgoingStatusPushNotificationsV4({
    directMessages: pendingMessages,
  }).catch((pushError) => {
    console.warn('Failed to send messaging v4 rekey-required push notifications:', pushError);
  });

  return {
    updatedCount: messageUpdateResult.modifiedCount || 0,
    resetAttachmentCount: attachmentResetResult.modifiedCount || 0,
  };
}

function normalizeDirectMessageObjectIds(messageIds) {
  if (!Array.isArray(messageIds)) {
    return [];
  }

  return messageIds
    .filter((entry) => typeof entry === 'string' && mongoose.Types.ObjectId.isValid(entry))
    .map((entry) => new mongoose.Types.ObjectId(entry));
}

async function loadOutgoingStatusMessagesV4({
  senderMessagingAccountId,
  limit,
  directMessageModel = DirectMessageV4,
}) {
  const actionableMessages = await directMessageModel.find({
    senderMessagingAccountId,
    status: { $in: ACTIONABLE_OUTGOING_MESSAGE_STATUSES },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  if (actionableMessages.length >= limit) {
    return actionableMessages;
  }

  const recentMessages = await directMessageModel.find({
    senderMessagingAccountId,
    status: { $nin: ACTIONABLE_OUTGOING_MESSAGE_STATUSES },
  })
    .sort({ createdAt: -1 })
    .limit(limit - actionableMessages.length)
    .lean();

  return actionableMessages.concat(recentMessages);
}

async function handleMessagingIdentityV4Get(req, res) {
  try {
    const resolved = await loadAuthenticatedMessagingIdentityV4(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ error: resolved.error.error });
    }

    return res.status(200).json({
      ok: true,
      messagingAccountId: resolved.account ? String(resolved.account._id) : null,
      binding: stripMessagingBindingV4(resolved.binding),
      directory: resolved.binding ? buildDirectoryV4Payload(resolved.binding) : null,
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error fetching messaging v4 identity:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingIdentityV4Post(req, res) {
  try {
    const normalized = normalizeAndValidateMessagingIdentityV4(req.body || {});
    if (normalized.errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: normalized.errors });
    }

    const binding = normalized.binding;
    const authenticatedWallet = await resolveAuthenticatedWalletPubkey(req, {
      walletPubkey: binding.walletPubkey,
    });
    if (authenticatedWallet.error) {
      return res.status(authenticatedWallet.error.status).json({ error: authenticatedWallet.error.error });
    }

    if (authenticatedWallet.walletPubkey !== binding.walletPubkey) {
      return res.status(403).json({ error: 'walletPubkey does not match the authenticated user' });
    }

    if (!verifyMessagingIdentityBindingV4(binding)) {
      return res.status(401).json({ error: 'Invalid messaging v4 identity signature' });
    }

    const resolvedAccount = await findOrCreateMessagingAccountV4(binding);
    if (resolvedAccount.error) {
      return res.status(resolvedAccount.error.status).json({ error: resolvedAccount.error.error });
    }

    const account = resolvedAccount.account;
    const activeBinding = await loadActiveMessagingBindingV4(account);
    const previousMessagingPubkey = normalizeMessagingPubkey(activeBinding?.messagingPubkey);
    const didRotate = !!activeBinding &&
      activeBinding.messagingPubkey !== binding.messagingPubkey;
    const didUpdate = !activeBinding || !bindingMatchesStoredRecord(activeBinding, binding);

    let storedBinding = activeBinding;
    if (didUpdate) {
      await MessagingBinding.updateMany(
        {
          messagingAccountId: account._id,
          active: true,
        },
        {
          $set: {
            active: false,
          },
        }
      );

      storedBinding = await MessagingBinding.create({
        messagingAccountId: account._id,
        ...buildEncryptedMessagingBindingStorageFields(binding),
        active: true,
      });
      storedBinding = materializeMessagingBindingV4(storedBinding);

      account.activeBindingId = storedBinding._id;
      await account.save();
    }

    if (didRotate && previousMessagingPubkey) {
      await markPendingMessagesRekeyRequiredV4({
        recipientMessagingAccountId: account._id,
        acceptedRecipientMessagingPubkeys: [previousMessagingPubkey],
      });
    }

    await deleteStaleMessagingDeviceRegistrationsV4({
      messagingAccountId: account._id,
      activeMessagingPubkey: binding.messagingPubkey,
    });

    return res.status(200).json({
      ok: true,
      didUpdate,
      didRotate,
      messagingAccountId: String(account._id),
      binding: stripMessagingBindingV4(storedBinding),
      directory: buildDirectoryV4Payload(storedBinding),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'Messaging identity already exists' });
    }

    console.error('Error registering messaging v4 identity:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingDirectoryLookupV4(req, res) {
  try {
    const lightningAddressHash = normalizePrivacyClientHash(req.body?.lightningAddressHash);
    const lightningAddressHashScheme = typeof req.body?.lightningAddressHashScheme === 'string'
      ? req.body.lightningAddressHashScheme.trim()
      : '';

    const errors = [];
    if (!lightningAddressHash) {
      errors.push('lightningAddressHash is required or invalid');
    }
    if (lightningAddressHashScheme !== LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME) {
      errors.push(`lightningAddressHashScheme must be ${LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME}`);
    }
    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const sender = await loadAuthenticatedMessagingIdentityV4(req);
    if (sender.error) {
      return res.status(sender.error.status).json({ error: sender.error.error });
    }
    if (!sender.account || !sender.binding) {
      return res.status(409).json({ error: 'Sender messaging v4 identity is not registered' });
    }

    const lightningAddressMessagingHmac = messagingDataHmac(lightningAddressHash);
    const recipientAccount = await MessagingAccount.findOne({ lightningAddressMessagingHmac });
    if (!recipientAccount) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipientAccount._id) === String(sender.account._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockStateV4({
      requesterMessagingAccountId: sender.account._id,
      targetMessagingAccountId: recipientAccount._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    const recipientBinding = await loadActiveMessagingBindingV4(recipientAccount);
    if (!recipientBinding) {
      return res.status(409).json({ error: 'Recipient messaging v4 is not active' });
    }

    return res.status(200).json({
      ok: true,
      recipient: stripMessagingBindingV4(recipientBinding),
      directory: buildDirectoryV4Payload(recipientBinding),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error resolving messaging v4 recipient:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingDeviceRegistrationV4Post(req, res) {
  try {
    const normalized = normalizeAndValidateMessagingDeviceRegistrationV4(req.body || {});
    if (normalized.errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: normalized.errors });
    }

    const registration = normalized.registration;
    const activeEnvironment = currentMessagingPushEnvironment();
    if (registration.environment !== activeEnvironment) {
      return res.status(409).json({
        error: `device registration environment mismatch (expected ${activeEnvironment})`,
      });
    }

    const resolved = await loadAuthenticatedMessagingIdentityV4(req, {
      walletPubkey: registration.walletPubkey,
    });
    if (resolved.error) {
      return res.status(resolved.error.status).json({ error: resolved.error.error });
    }
    if (!resolved.account || !resolved.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    if (resolved.walletPubkey !== registration.walletPubkey) {
      return res.status(403).json({ error: 'walletPubkey does not match the authenticated user' });
    }

    if (resolved.binding.messagingPubkey !== registration.messagingPubkey) {
      return res.status(409).json({ error: 'messagingPubkey does not match the active messaging identity' });
    }

    if (!verifyMessagingDeviceRegistrationV4(registration)) {
      return res.status(401).json({ error: 'Invalid messaging v4 device registration signature' });
    }

    const now = new Date();
    const deviceTokenLookupHmac = pushTokenLookupHmac(registration.deviceToken);
    const encryptedToken = encryptPushToken(registration.deviceToken);
    const messagingPubkeyHmac = buildMessagingPubkeyHmac(registration.messagingPubkey);
    const existing = await MessagingDeviceRegistrationV4.findOne({
      environment: registration.environment,
      deviceTokenLookupHmac,
    });

    const didUpdate = !existing ||
      String(existing.messagingAccountId) !== String(resolved.account._id) ||
      existing.messagingPubkeyHmac !== messagingPubkeyHmac ||
      existing.platform !== registration.platform ||
      existing.registrationSignature !== registration.registrationSignature ||
      Number(existing.registrationSignatureVersion) !== registration.registrationSignatureVersion ||
      bindingSignedAtSeconds(existing.registrationSignedAt) !== registration.registrationSignedAt ||
      (existing.appVersion || null) !== registration.appVersion ||
      (existing.bundleId || null) !== registration.bundleId;

    const storedRegistration = await MessagingDeviceRegistrationV4.findOneAndUpdate(
      {
        environment: registration.environment,
        deviceTokenLookupHmac,
      },
      {
        $set: {
          messagingAccountId: resolved.account._id,
          messagingPubkeyHmac,
          platform: registration.platform,
          environment: registration.environment,
          deviceTokenLookupHmac,
          ...encryptedToken,
          registrationSignature: registration.registrationSignature,
          registrationSignatureVersion: registration.registrationSignatureVersion,
          registrationSignedAt: registration.registrationSignedAtDate,
          appVersion: registration.appVersion,
          bundleId: registration.bundleId,
          lastSeenAt: now,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.status(200).json({
      ok: true,
      didUpdate,
      registration: stripMessagingDeviceRegistrationV4(storedRegistration),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error registering messaging v4 device registration:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingBlocksV4Get(req, res) {
  try {
    const requester = await loadAuthenticatedMessagingIdentityV4(req);
    if (requester.error) {
      return res.status(requester.error.status).json({ error: requester.error.error });
    }
    if (!requester.account || !requester.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const blocks = await UserBlockV4.find({
      blockerMessagingAccountId: requester.account._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      ok: true,
      blocks: blocks.map(stripUserBlockV4Payload),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error fetching messaging v4 blocks:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingBlocksV4Post(req, res) {
  try {
    const requester = await loadAuthenticatedMessagingIdentityV4(req);
    if (requester.error) {
      return res.status(requester.error.status).json({ error: requester.error.error });
    }
    if (!requester.account || !requester.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const lightningAddressHashScheme = typeof req.body?.lightningAddressHashScheme === 'string'
      ? req.body.lightningAddressHashScheme.trim()
      : '';
    if (lightningAddressHashScheme !== LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME) {
      return res.status(400).json({
        error: `lightningAddressHashScheme must be ${LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME}`,
      });
    }

    const resolvedTarget = await resolveMessagingBlockTargetV4(req.body || {});
    if (resolvedTarget.error) {
      return res.status(resolvedTarget.error.status).json({ error: resolvedTarget.error.error });
    }

    if (String(resolvedTarget.target._id) === String(requester.account._id)) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    const existing = await UserBlockV4.findOne({
      blockerMessagingAccountId: requester.account._id,
      blockedMessagingAccountId: resolvedTarget.target._id,
    });

    if (existing) {
      await cleanupBlockedConversationRelayDataV4({
        blockerMessagingAccountId: requester.account._id,
        blockedMessagingAccountId: resolvedTarget.target._id,
      });

      return res.status(200).json({
        ok: true,
        didUpdate: false,
        block: stripUserBlockV4Payload(existing),
      });
    }

    const block = await UserBlockV4.create({
      blockerMessagingAccountId: requester.account._id,
      blockedMessagingAccountId: resolvedTarget.target._id,
      blockedLightningAddressMessagingHmac: resolvedTarget.blockedLightningAddressMessagingHmac,
    });

    await cleanupBlockedConversationRelayDataV4({
      blockerMessagingAccountId: requester.account._id,
      blockedMessagingAccountId: resolvedTarget.target._id,
    });

    return res.status(200).json({
      ok: true,
      didUpdate: true,
      block: stripUserBlockV4Payload(block),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    if (error && error.code === 11000) {
      const [requester, resolvedTarget] = await Promise.all([
        loadAuthenticatedMessagingIdentityV4(req),
        resolveMessagingBlockTargetV4(req.body || {}),
      ]);
      if (!requester.error && requester.account && !resolvedTarget.error) {
        const existing = await UserBlockV4.findOne({
          blockerMessagingAccountId: requester.account._id,
          blockedMessagingAccountId: resolvedTarget.target._id,
        });

        if (existing) {
          return res.status(200).json({
            ok: true,
            didUpdate: false,
            block: stripUserBlockV4Payload(existing),
          });
        }
      }
    }

    console.error('Error creating messaging v4 block:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingBlocksV4Delete(req, res) {
  try {
    const requester = await loadAuthenticatedMessagingIdentityV4(req);
    if (requester.error) {
      return res.status(requester.error.status).json({ error: requester.error.error });
    }
    if (!requester.account || !requester.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const resolvedTarget = await resolveMessagingBlockTargetV4({
      lightningAddressHash: req.params?.target,
    });
    if (resolvedTarget.error) {
      if (resolvedTarget.error.status === 404) {
        return res.status(200).json({
          ok: true,
          didDelete: false,
        });
      }

      return res.status(resolvedTarget.error.status).json({ error: resolvedTarget.error.error });
    }

    const result = await UserBlockV4.deleteOne({
      blockerMessagingAccountId: requester.account._id,
      blockedMessagingAccountId: resolvedTarget.target._id,
    });

    return res.status(200).json({
      ok: true,
      didDelete: !!result.deletedCount,
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error deleting messaging v4 block:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.get('/messaging/v4/identity', userAuthMiddleware, handleMessagingIdentityV4Get);
router.post('/messaging/v4/identity', userAuthMiddleware, handleMessagingIdentityV4Post);
router.post('/messaging/v4/directory/lookup', userAuthMiddleware, handleMessagingDirectoryLookupV4);
router.post('/messaging/v4/device-registrations', userAuthMiddleware, handleMessagingDeviceRegistrationV4Post);
router.get('/messaging/v4/blocks', userAuthMiddleware, handleMessagingBlocksV4Get);
router.post('/messaging/v4/blocks', userAuthMiddleware, handleMessagingBlocksV4Post);
router.delete('/messaging/v4/blocks/:target', userAuthMiddleware, handleMessagingBlocksV4Delete);

router.post('/messaging/v4/attachments/upload', userAuthMiddleware, attachmentUpload.single('attachment'), async (req, res) => {
  try {
    const file = req.file;

    if (!file || !file.buffer || !file.size) {
      return res.status(400).json({ error: 'attachment file is required' });
    }

    const sender = await loadAuthenticatedMessagingIdentityV4(req);
    if (sender.error) {
      return res.status(sender.error.status).json({ error: sender.error.error });
    }
    if (!sender.account || !sender.binding) {
      return res.status(409).json({ error: 'Sender messaging v4 identity is not registered' });
    }

    const recipientResult = await resolveVerifiedMessagingRecipientV4({
      senderAccount: sender.account,
      recipientPayload: req.body || {},
    });
    if (recipientResult.error) {
      return res.status(recipientResult.error.status).json({
        error: recipientResult.error.error,
        details: recipientResult.error.details,
      });
    }

    const objectKey = buildAttachmentV4ObjectKey({
      senderMessagingAccountId: sender.account._id,
    });

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/octet-stream',
    }));

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_HOURS * 60 * 60 * 1000);
    const attachment = await MessageAttachmentV4.create({
      senderMessagingAccountId: sender.account._id,
      recipientMessagingAccountId: recipientResult.recipientAccount._id,
      recipientLightningAddressMessagingHmac: recipientResult.recipientLightningAddressMessagingHmac,
      objectKey,
      uploadContentType: file.mimetype || 'application/octet-stream',
      sizeBytes: file.size,
      status: 'uploaded',
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      attachment: stripAttachmentV4Payload(attachment),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error uploading messaging v4 attachment:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/messaging/v4/attachments/:attachmentId/download', userAuthMiddleware, async (req, res) => {
  try {
    const { attachmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ error: 'attachmentId is invalid' });
    }

    const requester = await loadAuthenticatedMessagingIdentityV4(req);
    if (requester.error) {
      return res.status(requester.error.status).json({ error: requester.error.error });
    }
    if (!requester.account || !requester.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const attachment = await MessageAttachmentV4.findById(attachmentId).select(
      '_id senderMessagingAccountId recipientMessagingAccountId objectKey uploadContentType status linkedMessageId expiresAt deletedAt'
    );

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const isSender = String(attachment.senderMessagingAccountId) === String(requester.account._id);
    const isRecipient = String(attachment.recipientMessagingAccountId) === String(requester.account._id);

    if (!isSender && !isRecipient) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (isRecipient && !attachment.linkedMessageId) {
      return res.status(404).json({ error: 'Attachment is not available yet' });
    }

    if (attachment.deletedAt || attachment.status === 'deleted' || attachment.status === 'expired') {
      return res.status(410).json({ error: 'Attachment is no longer available' });
    }

    if (attachment.expiresAt && attachment.expiresAt <= new Date()) {
      if (attachment.objectKey) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: attachment.objectKey,
          }));
        } catch (cleanupError) {
          console.warn('Failed to cleanup expired v4 attachment object:', cleanupError);
        }
      }

      attachment.status = 'expired';
      attachment.deletedAt = new Date();
      await attachment.save();
      return res.status(410).json({ error: 'Attachment has expired' });
    }

    const result = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: attachment.objectKey,
    }));

    res.setHeader('Content-Type', result.ContentType || attachment.uploadContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');

    if (result.ContentLength) {
      res.setHeader('Content-Length', String(result.ContentLength));
    }

    if (result.Body && typeof result.Body.pipe === 'function') {
      result.Body.pipe(res);
      return;
    }

    if (result.Body && typeof result.Body.transformToByteArray === 'function') {
      const bytes = await result.Body.transformToByteArray();
      return res.status(200).send(Buffer.from(bytes));
    }

    return res.status(500).json({ error: 'Attachment stream was unavailable' });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error downloading messaging v4 attachment:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/v4/attachments/mark-received', userAuthMiddleware, async (req, res) => {
  try {
    const attachmentIds = normalizeAttachmentIds(req.body?.attachmentIds);

    if (!attachmentIds.length) {
      return res.status(400).json({ error: 'attachmentIds is required' });
    }

    const recipient = await loadAuthenticatedMessagingIdentityV4(req);
    if (recipient.error) {
      return res.status(recipient.error.status).json({ error: recipient.error.error });
    }
    if (!recipient.account || !recipient.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const attachments = await MessageAttachmentV4.find({
      _id: { $in: attachmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
      recipientMessagingAccountId: recipient.account._id,
      status: { $in: ['linked', 'uploaded'] },
    }).select('_id objectKey status receivedAt deletedAt');

    if (!attachments.length) {
      return res.status(200).json({ ok: true, updatedCount: 0 });
    }

    let updatedCount = 0;
    const now = new Date();

    for (const attachment of attachments) {
      if (attachment.objectKey) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: attachment.objectKey,
          }));
        } catch (deleteError) {
          console.warn('Failed to delete received v4 attachment object:', deleteError);
        }
      }

      attachment.status = 'received';
      attachment.receivedAt = attachment.receivedAt || now;
      attachment.deletedAt = now;
      await attachment.save();
      updatedCount += 1;
    }

    return res.status(200).json({
      ok: true,
      updatedCount,
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error marking messaging v4 attachments received:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function handleMessagingSendV4(req, res) {
  try {
    const {
      clientMessageId,
      recipient,
      ciphertext,
      nonce,
      senderEphemeralPubkey,
      createdAtClient,
      createdAtClientMs,
      envelopeVersion,
      messageType,
      attachmentIds,
      sameKeyRetryCount,
    } = req.body || {};

    const sender = await loadAuthenticatedMessagingIdentityV4(req);
    if (sender.error) {
      return res.status(sender.error.status).json({ error: sender.error.error });
    }
    if (!sender.account || !sender.binding) {
      return res.status(409).json({ error: 'Sender messaging v4 identity is not registered' });
    }

    const errors = [];
    const normalizedClientMessageId = typeof clientMessageId === 'string'
      ? clientMessageId.trim()
      : '';
    if (!normalizedClientMessageId) errors.push('clientMessageId is required');
    if (!ciphertext || typeof ciphertext !== 'string') errors.push('ciphertext is required');
    if (!nonce || typeof nonce !== 'string') errors.push('nonce is required');
    if (!senderEphemeralPubkey || typeof senderEphemeralPubkey !== 'string') {
      errors.push('senderEphemeralPubkey is required');
    }

    const normalizedEnvelopeVersion = Number.isInteger(envelopeVersion) ? envelopeVersion : 4;
    if (normalizedEnvelopeVersion < 4) {
      errors.push('envelopeVersion must be 4 or greater for messaging v4');
    }

    const normalizedCreatedAtClientMs = parseClientTimestampMs(createdAtClientMs ?? createdAtClient);
    if (!Number.isInteger(normalizedCreatedAtClientMs) || normalizedCreatedAtClientMs <= 0) {
      errors.push('createdAtClientMs is required');
    }

    const normalizedMessageType = typeof messageType === 'string'
      ? messageType.trim().toLowerCase()
      : 'text';
    if (!['text', 'payment_request', 'payment_request_paid', 'attachment', 'reaction'].includes(normalizedMessageType)) {
      errors.push('messageType must be text, payment_request, payment_request_paid, attachment, or reaction');
    }
    const normalizedAttachmentIds = normalizeAttachmentIds(attachmentIds);
    if (normalizedMessageType === 'attachment' && !normalizedAttachmentIds.length) {
      errors.push('attachmentIds is required for attachment messages');
    }
    if (normalizedMessageType !== 'attachment' && normalizedAttachmentIds.length) {
      errors.push('attachmentIds can only be provided for attachment messages');
    }

    const normalizedSameKeyRetryCount = parseIntegerValue(sameKeyRetryCount);
    if (normalizedSameKeyRetryCount != null &&
        (normalizedSameKeyRetryCount < 0 || normalizedSameKeyRetryCount > 1)) {
      errors.push('sameKeyRetryCount must be 0 or 1');
    }

    const recipientLightningAddressHash = normalizePrivacyClientHash(recipient?.lightningAddressHash);
    const recipientLightningAddressHashScheme = typeof recipient?.lightningAddressHashScheme === 'string'
      ? recipient.lightningAddressHashScheme.trim()
      : '';
    if (!recipientLightningAddressHash) {
      errors.push('recipient.lightningAddressHash is required or invalid');
    }
    if (recipientLightningAddressHashScheme !== LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME) {
      errors.push(`recipient.lightningAddressHashScheme must be ${LIGHTNING_ADDRESS_CLIENT_HASH_SCHEME}`);
    }

    const normalizedRecipient = normalizeAndValidateMessagingIdentityV4(recipient || {});
    if (normalizedRecipient.errors.length) {
      errors.push(...normalizedRecipient.errors.map((entry) => `recipient.${entry}`));
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const recipientResult = await resolveVerifiedMessagingRecipientV4({
      senderAccount: sender.account,
      recipientPayload: recipient || {},
    });
    if (recipientResult.error) {
      return res.status(recipientResult.error.status).json({
        error: recipientResult.error.error,
        details: recipientResult.error.details,
      });
    }

    let attachmentsToLink = [];
    if (normalizedAttachmentIds.length) {
      attachmentsToLink = await MessageAttachmentV4.find({
        _id: { $in: normalizedAttachmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
        senderMessagingAccountId: sender.account._id,
        recipientMessagingAccountId: recipientResult.recipientAccount._id,
        recipientLightningAddressMessagingHmac: recipientResult.recipientLightningAddressMessagingHmac,
        status: 'uploaded',
      }).select('_id');

      if (attachmentsToLink.length !== normalizedAttachmentIds.length) {
        return res.status(409).json({ error: 'One or more attachments are invalid, stale, or already linked' });
      }
    }

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_HOURS * 60 * 60 * 1000);
    const directMessage = await DirectMessageV4.create({
      senderMessagingAccountId: sender.account._id,
      recipientMessagingAccountId: recipientResult.recipientAccount._id,
      recipientLightningAddressMessagingHmac: recipientResult.recipientLightningAddressMessagingHmac,
      senderMessagingPubkey: sender.binding.messagingPubkey,
      recipientMessagingPubkey: recipientResult.activeRecipientBinding.messagingPubkey,
      clientMessageId: normalizedClientMessageId,
      messageType: normalizedMessageType,
      status: 'pending',
      sameKeyRetryCount: normalizedSameKeyRetryCount ?? 0,
      envelopeVersion: normalizedEnvelopeVersion,
      ciphertext: ciphertext.trim(),
      nonce: nonce.trim(),
      senderEphemeralPubkey: senderEphemeralPubkey.trim(),
      createdAtClient: new Date(normalizedCreatedAtClientMs),
      expiresAt,
    });

    if (attachmentsToLink.length) {
      await MessageAttachmentV4.updateMany(
        { _id: { $in: attachmentsToLink.map((attachment) => attachment._id) } },
        {
          $set: {
            status: 'linked',
            linkedMessageId: directMessage._id,
            linkedClientMessageId: directMessage.clientMessageId,
          },
        }
      );
    }

    await sendPushNotificationsForDirectMessageV4({
      directMessage,
    }).catch((pushError) => {
      console.warn('Failed to send messaging v4 push notifications:', pushError);
      return null;
    });

    return res.status(200).json({
      ok: true,
      message: {
        messageId: String(directMessage._id),
        clientMessageId: directMessage.clientMessageId,
        recipientMessagingAccountId: String(directMessage.recipientMessagingAccountId),
        recipientMessagingPubkey: directMessage.recipientMessagingPubkey,
        status: directMessage.status,
        createdAt: directMessage.createdAt,
        createdAtClient: directMessage.createdAtClient,
      },
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const sender = await loadAuthenticatedMessagingIdentityV4(req);
      if (sender.account) {
        const existing = await DirectMessageV4.findOne({
          senderMessagingAccountId: sender.account._id,
          clientMessageId: req.body?.clientMessageId,
        }).lean();

        if (existing) {
          return res.status(200).json({
            ok: true,
            deduped: true,
            message: {
              messageId: String(existing._id),
              clientMessageId: existing.clientMessageId,
              recipientMessagingAccountId: String(existing.recipientMessagingAccountId),
              recipientMessagingPubkey: existing.recipientMessagingPubkey,
              status: existing.status,
              createdAt: existing.createdAt,
              createdAtClient: existing.createdAtClient,
            },
          });
        }
      }
    }

    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error sending messaging v4 message:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingInboxV4(req, res) {
  try {
    const recipient = await loadAuthenticatedMessagingIdentityV4(req);
    if (recipient.error) {
      return res.status(recipient.error.status).json({ error: recipient.error.error });
    }
    if (!recipient.account || !recipient.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const messages = await DirectMessageV4.find({
      recipientMessagingAccountId: recipient.account._id,
      recipientMessagingPubkey: recipient.binding.messagingPubkey,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      ok: true,
      messages: messages.map(stripDirectMessageV4Payload),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error fetching messaging v4 inbox:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingAckV4(req, res) {
  try {
    const recipient = await loadAuthenticatedMessagingIdentityV4(req);
    if (recipient.error) {
      return res.status(recipient.error.status).json({ error: recipient.error.error });
    }
    if (!recipient.account || !recipient.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const result = await DirectMessageV4.deleteMany({
      _id: { $in: objectIds },
      recipientMessagingAccountId: recipient.account._id,
      recipientMessagingPubkey: recipient.binding.messagingPubkey,
      status: 'pending',
    });

    return res.status(200).json({
      ok: true,
      acknowledgedCount: result.deletedCount || 0,
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error acknowledging messaging v4 messages:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleOutgoingMessagingStatusesV4(req, res) {
  try {
    const sender = await loadAuthenticatedMessagingIdentityV4(req);
    if (sender.error) {
      return res.status(sender.error.status).json({ error: sender.error.error });
    }
    if (!sender.account || !sender.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const messages = await loadOutgoingStatusMessagesV4({
      senderMessagingAccountId: sender.account._id,
      limit,
    });

    return res.status(200).json({
      ok: true,
      messages: messages.map(stripDirectMessageV4Payload),
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error fetching outgoing messaging v4 statuses:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingRekeyRequiredV4(req, res) {
  try {
    const recipient = await loadAuthenticatedMessagingIdentityV4(req);
    if (recipient.error) {
      return res.status(recipient.error.status).json({ error: recipient.error.error });
    }
    if (!recipient.account || !recipient.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const result = await markPendingMessagesRekeyRequiredV4({
      recipientMessagingAccountId: recipient.account._id,
      acceptedRecipientMessagingPubkeys: [recipient.binding.messagingPubkey],
      objectIds,
    });

    return res.status(200).json({
      ok: true,
      updatedCount: result.updatedCount,
      resetAttachmentCount: result.resetAttachmentCount,
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error marking messaging v4 messages rekey-required:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingDecryptFailedV4(req, res) {
  try {
    const recipient = await loadAuthenticatedMessagingIdentityV4(req);
    if (recipient.error) {
      return res.status(recipient.error.status).json({ error: recipient.error.error });
    }
    if (!recipient.account || !recipient.binding) {
      return res.status(409).json({ error: 'Messaging v4 identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const now = new Date();
    const pendingMessages = await DirectMessageV4.find({
      _id: { $in: objectIds },
      recipientMessagingAccountId: recipient.account._id,
      recipientMessagingPubkey: recipient.binding.messagingPubkey,
      status: 'pending',
    }).select('_id senderMessagingAccountId recipientMessagingAccountId sameKeyRetryCount');

    if (!pendingMessages.length) {
      return res.status(200).json({
        ok: true,
        retryRequiredCount: 0,
        failedCount: 0,
        resetAttachmentCount: 0,
      });
    }

    const retryRequiredMessageIds = pendingMessages
      .filter((message) => Number(message.sameKeyRetryCount || 0) < 1)
      .map((message) => message._id);
    const failedMessageIds = pendingMessages
      .filter((message) => Number(message.sameKeyRetryCount || 0) >= 1)
      .map((message) => message._id);
    const allMessageIds = pendingMessages.map((message) => message._id);

    const updateOperations = [];

    if (retryRequiredMessageIds.length) {
      updateOperations.push(
        DirectMessageV4.updateMany(
          {
            _id: { $in: retryRequiredMessageIds },
            status: 'pending',
          },
          {
            $set: {
              status: 'same_key_retry_required',
              sameKeyRetryCount: 1,
              sameKeyDecryptFailedAt: now,
            },
            $unset: {
              ciphertext: '',
              nonce: '',
              senderEphemeralPubkey: '',
              deliveredAt: '',
              rekeyRequiredAt: '',
              failedAt: '',
              expiredAt: '',
            },
          }
        )
      );
    }

    if (failedMessageIds.length) {
      updateOperations.push(
        DirectMessageV4.updateMany(
          {
            _id: { $in: failedMessageIds },
            status: 'pending',
          },
          {
            $set: {
              status: 'failed_same_key',
              sameKeyDecryptFailedAt: now,
              failedAt: now,
            },
            $unset: {
              ciphertext: '',
              nonce: '',
              senderEphemeralPubkey: '',
              deliveredAt: '',
              rekeyRequiredAt: '',
              expiredAt: '',
            },
          }
        )
      );
    }

    updateOperations.push(
      MessageAttachmentV4.updateMany(
        {
          linkedMessageId: { $in: allMessageIds },
          recipientMessagingAccountId: recipient.account._id,
          status: 'linked',
        },
        {
          $set: {
            status: 'uploaded',
          },
          $unset: {
            linkedMessageId: '',
            linkedClientMessageId: '',
          },
        }
      )
    );

    const updateResults = await Promise.all(updateOperations);
    const attachmentResetResult = updateResults[updateResults.length - 1];

    void sendOutgoingStatusPushNotificationsV4({
      directMessages: pendingMessages,
    }).catch((pushError) => {
      console.warn('Failed to send messaging v4 outgoing-status push notifications:', pushError);
    });

    return res.status(200).json({
      ok: true,
      retryRequiredCount: retryRequiredMessageIds.length,
      failedCount: failedMessageIds.length,
      resetAttachmentCount: attachmentResetResult.modifiedCount || 0,
    });
  } catch (error) {
    if (isMessagingPrivacyConfigurationError(error)) {
      return res.status(500).json({ error: 'Messaging privacy configuration is missing' });
    }

    console.error('Error marking messaging v4 messages decrypt-failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.post('/messaging/v4/send', userAuthMiddleware, handleMessagingSendV4);
router.get('/messaging/v4/inbox', userAuthMiddleware, handleMessagingInboxV4);
router.post('/messaging/v4/ack', userAuthMiddleware, handleMessagingAckV4);
router.get('/messaging/v4/outgoing-statuses', userAuthMiddleware, handleOutgoingMessagingStatusesV4);
router.post('/messaging/v4/rekey-required', userAuthMiddleware, handleMessagingRekeyRequiredV4);
router.post('/messaging/v4/decrypt-failed', userAuthMiddleware, handleMessagingDecryptFailedV4);

module.exports = router;
