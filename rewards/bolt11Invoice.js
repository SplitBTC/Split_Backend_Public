const crypto = require('crypto');
const secp = require('@noble/secp256k1');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHECKSUM_LENGTH = 6;
const SIGNATURE_BASE32_LENGTH = 104;
const TIMESTAMP_BASE32_LENGTH = 7;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function decodeBolt11(invoice) {
  const normalized = String(invoice || '').trim().toLowerCase();
  const decoded = decodeBech32(normalized);
  if (!decoded || !decoded.hrp.startsWith('lnbc')) return null;

  const amountSats = parseAmountSats(decoded.hrp);
  if (decoded.data.length <= TIMESTAMP_BASE32_LENGTH) {
    return { amountSats, paymentHash: null, destinationPubkey: null };
  }

  const taggedFields = decoded.data.slice(TIMESTAMP_BASE32_LENGTH);
  const fieldsEnd = Math.max(taggedFields.length - SIGNATURE_BASE32_LENGTH, 0);
  let index = 0;
  let paymentHash = null;
  let destinationPubkey = null;

  while (index + 3 <= fieldsEnd) {
    const tag = taggedFields[index];
    const dataLength = (taggedFields[index + 1] << 5) + taggedFields[index + 2];
    index += 3;
    if (index + dataLength > fieldsEnd) break;

    const fieldData = taggedFields.slice(index, index + dataLength);
    index += dataLength;
    const fieldBytes = convertBits(fieldData, 5, 8, false);
    if (!fieldBytes) continue;

    if (tag === 1 && fieldBytes.length === 32) {
      paymentHash = Buffer.from(fieldBytes).toString('hex');
    } else if (tag === 19 && fieldBytes.length === 33) {
      destinationPubkey = Buffer.from(fieldBytes).toString('hex');
    }
  }

  const payload = invoiceSignaturePayload(decoded.hrp, decoded.data);
  if (!payload) return { amountSats, paymentHash, destinationPubkey };

  if (destinationPubkey) {
    const verified = secp.verify(
      Uint8Array.from(payload.signature),
      Uint8Array.from(payload.messageHash),
      Buffer.from(destinationPubkey, 'hex'),
      { prehash: false, lowS: false }
    );
    if (!verified) return null;
  } else {
    try {
      destinationPubkey = Buffer.from(
        secp.recoverPublicKey(
          Uint8Array.from(payload.messageHash),
          Uint8Array.from(payload.signature),
          payload.recoveryId,
          true
        )
      ).toString('hex');
    } catch {
      destinationPubkey = null;
    }
  }

  return { amountSats, paymentHash, destinationPubkey };
}

function invoiceSignaturePayload(hrp, data) {
  if (data.length < SIGNATURE_BASE32_LENGTH) return null;
  const signatureBytes = convertBits(data.slice(-SIGNATURE_BASE32_LENGTH), 5, 8, false);
  const messageBytes = convertBits(data.slice(0, -SIGNATURE_BASE32_LENGTH), 5, 8, true);
  if (!signatureBytes || !messageBytes || signatureBytes.length !== 65) return null;

  const signedPayload = Buffer.concat([Buffer.from(hrp, 'utf8'), Buffer.from(messageBytes)]);
  return {
    messageHash: crypto.createHash('sha256').update(signedPayload).digest(),
    signature: signatureBytes.slice(0, 64),
    recoveryId: signatureBytes[64],
  };
}

function parseAmountSats(hrp) {
  const amountPart = hrp.slice('lnbc'.length);
  if (!amountPart) return null;
  const unit = ['m', 'u', 'n', 'p'].includes(amountPart.at(-1)) ? amountPart.at(-1) : null;
  const numeric = unit ? amountPart.slice(0, -1) : amountPart;
  if (!/^\d+$/.test(numeric)) return null;

  const amount = BigInt(numeric);
  const satsPerBtc = 100_000_000n;
  const sats = (() => {
    if (unit === 'm') return amount * satsPerBtc / 1_000n;
    if (unit === 'u') return amount * satsPerBtc / 1_000_000n;
    if (unit === 'n') return amount * satsPerBtc / 1_000_000_000n;
    if (unit === 'p') return amount * satsPerBtc / 1_000_000_000_000n;
    return amount * satsPerBtc;
  })();

  return Number(sats);
}

function decodeBech32(value) {
  if (!value || (value !== value.toLowerCase() && value !== value.toUpperCase())) return null;
  const normalized = value.toLowerCase();
  const separatorIndex = normalized.lastIndexOf('1');
  if (separatorIndex <= 0) return null;
  const hrp = normalized.slice(0, separatorIndex);
  const dataPart = normalized.slice(separatorIndex + 1);
  if (dataPart.length <= CHECKSUM_LENGTH) return null;

  const values = [];
  for (const char of dataPart) {
    const idx = CHARSET.indexOf(char);
    if (idx < 0) return null;
    values.push(idx);
  }

  if (polymod(hrpExpand(hrp).concat(values)) !== 1) return null;
  return { hrp, data: values.slice(0, -CHECKSUM_LENGTH) };
}

function hrpExpand(hrp) {
  const bytes = Array.from(Buffer.from(hrp, 'utf8'));
  return bytes.map((b) => b >> 5).concat([0], bytes.map((b) => b & 31));
}

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if (((top >>> i) & 1) !== 0) chk ^= GENERATOR[i];
    }
  }
  return chk >>> 0;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const result = [];

  for (const value of data) {
    if ((value >> fromBits) !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }

  return result;
}

module.exports = { decodeBolt11 };
