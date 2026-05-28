const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProof32ByteHex } = require('../rewards/rewardProofEncoding');

const proofHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const proofBytes = Buffer.from(proofHex, 'hex');

test('normalizeProof32ByteHex accepts canonical hex', () => {
  assert.deepEqual(normalizeProof32ByteHex(` ${proofHex.toUpperCase()} `), {
    hex: proofHex,
    encoding: 'hex',
  });
});

test('normalizeProof32ByteHex converts LND-style base64 bytes to hex', () => {
  assert.deepEqual(normalizeProof32ByteHex(proofBytes.toString('base64')), {
    hex: proofHex,
    encoding: 'base64',
  });
});

test('normalizeProof32ByteHex converts base64url bytes to hex', () => {
  const urlProofBytes = Buffer.alloc(32, 0xff);
  const urlProofHex = urlProofBytes.toString('hex');

  assert.deepEqual(normalizeProof32ByteHex(urlProofBytes.toString('base64url')), {
    hex: urlProofHex,
    encoding: 'base64url',
  });
});

test('normalizeProof32ByteHex rejects non-32-byte values', () => {
  assert.equal(normalizeProof32ByteHex(Buffer.from('short').toString('base64')), null);
  assert.equal(normalizeProof32ByteHex('not-valid-proof'), null);
  assert.equal(normalizeProof32ByteHex('0'.repeat(62)), null);
});
