const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const MessageAttachmentV4 = require('../models/MessageAttachmentV4');

test('MessageAttachmentV4 stores messaging-domain attachment metadata without raw user identity fields', () => {
  const attachment = new MessageAttachmentV4({
    senderMessagingAccountId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439101'),
    recipientMessagingAccountId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439102'),
    recipientLightningAddressMessagingHmac: 'a'.repeat(64),
    objectKey: 'messaging-v4-attachments/account-1/file.bin',
    uploadContentType: 'image/png',
    sizeBytes: 12345,
    status: 'uploaded',
    expiresAt: new Date('2026-04-02T12:00:00.000Z'),
  });

  const validationError = attachment.validateSync();
  assert.equal(validationError, undefined);

  assert.equal(attachment.senderUserId, undefined);
  assert.equal(attachment.recipientUserId, undefined);
  assert.equal(attachment.recipientLightningAddress, undefined);
});

test('MessageAttachmentV4 requires messaging participants and hashed recipient lookup metadata', () => {
  const attachment = new MessageAttachmentV4({
    objectKey: 'messaging-v4-attachments/account-1/file.bin',
    sizeBytes: 1,
    expiresAt: new Date('2026-04-02T12:00:00.000Z'),
  });

  const validationError = attachment.validateSync();

  assert.ok(validationError);
  assert.ok(validationError.errors.senderMessagingAccountId);
  assert.ok(validationError.errors.recipientMessagingAccountId);
  assert.ok(validationError.errors.recipientLightningAddressMessagingHmac);
});
