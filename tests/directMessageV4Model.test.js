const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const DirectMessageV4 = require('../models/DirectMessageV4');

test('DirectMessageV4 validates sealed relay metadata without raw user identity fields', () => {
  const message = new DirectMessageV4({
    senderMessagingAccountId: new mongoose.Types.ObjectId(),
    recipientMessagingAccountId: new mongoose.Types.ObjectId(),
    recipientLightningAddressMessagingHmac: 'a'.repeat(64),
    senderMessagingPubkey: '02' + 'b'.repeat(64),
    recipientMessagingPubkey: '02' + 'c'.repeat(64),
    clientMessageId: 'client-message-1',
    messageType: 'text',
    envelopeVersion: 4,
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    senderEphemeralPubkey: '02' + 'd'.repeat(64),
    createdAtClient: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  const validationError = message.validateSync();

  assert.equal(validationError, undefined);
  assert.equal(message.senderUserId, undefined);
  assert.equal(message.recipientUserId, undefined);
  assert.equal(message.senderWalletPubkey, undefined);
  assert.equal(message.recipientWalletPubkey, undefined);
  assert.equal(message.recipientLightningAddress, undefined);
});

test('DirectMessageV4 requires messaging-domain participants and hashed recipient lookup metadata', () => {
  const message = new DirectMessageV4({
    clientMessageId: 'client-message-1',
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    senderEphemeralPubkey: 'sender-ephemeral',
    expiresAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  const validationError = message.validateSync();

  assert.ok(validationError);
  assert.ok(validationError.errors.senderMessagingAccountId);
  assert.ok(validationError.errors.recipientMessagingAccountId);
  assert.ok(validationError.errors.recipientLightningAddressMessagingHmac);
  assert.ok(validationError.errors.senderMessagingPubkey);
  assert.ok(validationError.errors.recipientMessagingPubkey);
});
