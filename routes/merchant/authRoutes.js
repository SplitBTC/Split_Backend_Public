const express = require('express');
const jwt = require('jsonwebtoken');

const Merchant = require('../../models/Merchant');
const merchantSessionHelper = require('../../merchant/merchantSessionHelper');
const merchantAuthMiddleware = require('../../middlewares/merchantAuthMiddleware');
const { serializeMerchant, validateAccountPayload } = require('../../merchant/accountPayload');

const router = express.Router();

function getJwtSecretKey() {
  return process.env.secretKey;
}

function normalizePubkey(pubkey) {
  return typeof pubkey === 'string' ? pubkey.trim().toLowerCase() : '';
}

function validateWalletAuthPayload(payload) {
  const errors = [];
  const pubkey = normalizePubkey(payload?.pubkey);
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : '';
  const signature = typeof payload?.signature === 'string' ? payload.signature.trim() : '';

  if (!pubkey) errors.push('pubkey is required');
  if (!nonce) errors.push('nonce is required');
  if (!signature) errors.push('signature is required');
  if (payload?.iat !== undefined && payload?.iat !== null && Number.isNaN(Number(payload.iat))) {
    errors.push('iat must be a number if provided');
  }

  return { errors, pubkey, nonce, signature };
}

function setMerchantSessionCookie(res, merchant) {
  const token = jwt.sign(
    {
      type: 'merchant',
      merchantId: String(merchant._id),
      pubkey: merchant.sparkWalletPubkey,
    },
    getJwtSecretKey(),
    { expiresIn: '1h' }
  );

  res.cookie('merchantJwtToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000,
  });
}

function verifyWalletSignature({ pubkey, nonce, signature }) {
  const nonceRecord = merchantSessionHelper.peekNonce(nonce);
  if (!nonceRecord) {
    return { ok: false, status: 401, error: 'Invalid or expired nonce' };
  }

  const isValid = merchantSessionHelper.verifyBreezSignedMessage({
    message: nonceRecord.messageToSign,
    pubkey,
    signature,
  });

  if (!isValid) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }

  merchantSessionHelper.consumeNonce(nonce);
  return { ok: true };
}

router.post('/auth/nonce', async (_req, res) => {
  try {
    const domain = process.env.MERCHANT_WALLET_AUTH_DOMAIN || 'merchant.example.invalid';
    const { nonce, expiresAt, messageToSign } = merchantSessionHelper.issueNonce({ domain });

    return res.status(200).json({ nonce, expiresAt, messageToSign });
  } catch (error) {
    console.error('Error generating merchant nonce:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/breez-api-key', async (_req, res) => {
  try {
    const breezApiKey = process.env.BREEZ_API_KEY;
    if (!breezApiKey) {
      console.error('Missing BREEZ_API_KEY in environment');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    return res.status(200).json({ apiKey: breezApiKey });
  } catch (error) {
    console.error('Merchant Breez API key route error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/auth/register', async (req, res) => {
  try {
    const { errors: authErrors, pubkey, nonce, signature } = validateWalletAuthPayload(req.body || {});
    const { errors: accountErrors, normalized } = validateAccountPayload(req.body || {});
    const errors = [...authErrors, ...accountErrors];

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const verification = verifyWalletSignature({ pubkey, nonce, signature });
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    const existingMerchant = await Merchant.findOne({ sparkWalletPubkey: pubkey });
    if (existingMerchant) {
      return res.status(409).json({ error: 'Merchant already exists' });
    }

	    const merchant = await Merchant.create({
	      sparkWalletPubkey: pubkey,
	      businessName: normalized.businessName,
	      email: normalized.email,
      phone: normalized.phone,
      address: normalized.address,
      lastLoginAt: new Date(),
    });

    setMerchantSessionCookie(res, merchant);

    return res.status(201).json({
      ok: true,
      merchant: serializeMerchant(merchant),
    });
  } catch (error) {
    console.error('Error registering merchant:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/auth/wallet-login', async (req, res) => {
  try {
    const { errors, pubkey, nonce, signature } = validateWalletAuthPayload(req.body || {});

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const verification = verifyWalletSignature({ pubkey, nonce, signature });
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    const merchant = await Merchant.findOne({ sparkWalletPubkey: pubkey });
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    merchant.lastLoginAt = new Date();
    await merchant.save();

    setMerchantSessionCookie(res, merchant);

    return res.status(200).json({
      ok: true,
      merchant: serializeMerchant(merchant),
    });
  } catch (error) {
    console.error('Error in merchant wallet-login:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/session', merchantAuthMiddleware, async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.merchantId);
    if (!merchant) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      ok: true,
      merchant: serializeMerchant(merchant),
    });
  } catch (error) {
    console.error('Error checking merchant session:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
