const test = require('node:test');
const assert = require('node:assert/strict');

const DirectMessageV4 = require('../models/DirectMessageV4');
const MessageAttachmentV4 = require('../models/MessageAttachmentV4');
const MessagingAccount = require('../models/MessagingAccount');
const MessagingDeviceRegistrationV4 = require('../models/MessagingDeviceRegistrationV4');
const UserBlockV4 = require('../models/UserBlockV4');

const disallowedV4StoragePaths = [
  'userId',
  'senderUserId',
  'recipientUserId',
  'blockerUserId',
  'blockedUserId',
  'lightningAddress',
  'recipientLightningAddress',
  'blockedLightningAddress',
  'profilePicUrl',
  'blockedProfilePicUrl',
  'deviceToken',
  'walletPubkey',
  'senderWalletPubkey',
  'recipientWalletPubkey',
  'blockedWalletPubkey',
];

const privacyFirstModels = [
  DirectMessageV4,
  MessageAttachmentV4,
  MessagingAccount,
  MessagingDeviceRegistrationV4,
  UserBlockV4,
];

test('v4 privacy-first storage models do not reintroduce core user identity paths', () => {
  for (const model of privacyFirstModels) {
    const paths = Object.keys(model.schema.paths);
    const presentDisallowedPaths = disallowedV4StoragePaths.filter((path) => paths.includes(path));

    assert.deepEqual(
      presentDisallowedPaths,
      [],
      `${model.modelName} must stay keyed by messaging-domain identifiers`
    );
  }
});
