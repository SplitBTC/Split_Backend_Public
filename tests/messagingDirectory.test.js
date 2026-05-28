const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  buildBindingLeafHash,
  buildMerkleProof,
  canonicalizeBinding,
  computeMerkleRoot,
  emptyRootHash,
} = require('../messaging/messagingDirectory');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function combineMerkleHashes(leftHex, rightHex) {
  return sha256(Buffer.concat([
    Buffer.from(leftHex, 'hex'),
    Buffer.from(rightHex, 'hex'),
  ]));
}

function computeRootFromProof(leafHash, proof) {
  return proof.reduce((cursor, step) => {
    if (step.position === 'left') {
      return combineMerkleHashes(step.hash, cursor);
    }

    return combineMerkleHashes(cursor, step.hash);
  }, leafHash);
}

function buildBinding(overrides = {}) {
  return {
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lightningAddress: 'alice@example.com',
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentitySignature: '3045022100feedface',
    messagingIdentitySignatureVersion: 2,
    messagingIdentitySignedAt: 1_712_000_000,
    ...overrides,
  };
}

test('canonicalizeBinding normalizes casing and trims user-controlled fields', () => {
  const normalized = canonicalizeBinding(buildBinding({
    walletPubkey: '  02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  ',
    lightningAddress: '  Alice@Example.com ',
    messagingPubkey: '  02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  ',
    messagingIdentitySignature: '  3045022100FEEDFACE  ',
    messagingIdentitySignatureVersion: '2',
    messagingIdentitySignedAt: '1712000000',
  }));

  assert.deepEqual(normalized, {
    walletPubkey: '02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    lightningAddress: 'alice@example.com',
    messagingPubkey: '02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    messagingIdentitySignature: '3045022100FEEDFACE',
    messagingIdentitySignatureVersion: 2,
    messagingIdentitySignedAt: 1712000000,
  });
});

test('buildBindingLeafHash is stable across whitespace and address-case changes', () => {
  const baseHash = buildBindingLeafHash(buildBinding());
  const variantHash = buildBindingLeafHash(buildBinding({
    lightningAddress: '  ALICE@EXAMPLE.COM ',
    walletPubkey: ' 02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ',
    messagingPubkey: ' 02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ',
    messagingIdentitySignature: ' 3045022100feedface ',
  }));

  assert.equal(variantHash, baseHash);
});

test('computeMerkleRoot returns the empty root when no leaves exist', () => {
  assert.equal(computeMerkleRoot([]), emptyRootHash());
});

test('buildMerkleProof can reconstruct the current root for an odd-sized tree', () => {
  const leafHashes = [
    buildBindingLeafHash(buildBinding()),
    buildBindingLeafHash(buildBinding({
      walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      lightningAddress: 'bob@example.com',
      messagingPubkey: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    })),
    buildBindingLeafHash(buildBinding({
      walletPubkey: '02eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      lightningAddress: 'carol@example.com',
      messagingPubkey: '02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    })),
  ];

  const proof = buildMerkleProof(leafHashes, 1);
  const root = computeMerkleRoot(leafHashes);

  assert.equal(computeRootFromProof(leafHashes[1], proof), root);
  assert.equal(proof.length, 2);
});

test('buildMerkleProof rejects an invalid leaf index', () => {
  assert.throws(
    () => buildMerkleProof(['a'.repeat(64)], 2),
    /Invalid merkle proof leaf index/
  );
});
