function normalizeProof32ByteHex(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return {
      hex: trimmed.toLowerCase(),
      encoding: 'hex',
    };
  }

  const base64Hex = decodeBase64Like32ByteHex(trimmed);
  if (base64Hex) {
    return {
      hex: base64Hex,
      encoding: trimmed.includes('-') || trimmed.includes('_') ? 'base64url' : 'base64',
    };
  }

  return null;
}

function decodeBase64Like32ByteHex(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;

  const unpadded = value.replace(/=+$/u, '');
  if (unpadded.length % 4 === 1) return null;

  const standardUnpadded = unpadded.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = standardUnpadded.padEnd(
    standardUnpadded.length + ((4 - (standardUnpadded.length % 4)) % 4),
    '='
  );
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length !== 32) return null;

  const expectedUnpadded = decoded.toString('base64').replace(/=+$/u, '');
  if (standardUnpadded !== expectedUnpadded) return null;

  return decoded.toString('hex');
}

module.exports = {
  normalizeProof32ByteHex,
};
