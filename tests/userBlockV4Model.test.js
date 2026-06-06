const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const UserBlockV4 = require('../models/UserBlockV4');

test('UserBlockV4 stores messaging-domain block identifiers without raw identity metadata', () => {
  const block = new UserBlockV4({
    blockerMessagingAccountId: new mongoose.Types.ObjectId(),
    blockedMessagingAccountId: new mongoose.Types.ObjectId(),
    blockedLightningAddressMessagingHmac: 'a'.repeat(64),
  });

  const validationError = block.validateSync();

  assert.equal(validationError, undefined);
  assert.equal(block.blockerUserId, undefined);
  assert.equal(block.blockedUserId, undefined);
  assert.equal(block.blockedWalletPubkey, undefined);
  assert.equal(block.blockedLightningAddress, undefined);
  assert.equal(block.blockedProfilePicUrl, undefined);
});

test('UserBlockV4 requires blocker, blocked account, and hashed Lightning address metadata', () => {
  const block = new UserBlockV4({});
  const validationError = block.validateSync();

  assert.ok(validationError);
  assert.ok(validationError.errors.blockerMessagingAccountId);
  assert.ok(validationError.errors.blockedMessagingAccountId);
  assert.ok(validationError.errors.blockedLightningAddressMessagingHmac);
});
