const express = require('express');

const Merchant = require('../../models/Merchant');
const merchantAuthMiddleware = require('../../middlewares/merchantAuthMiddleware');
const { serializeMerchant, validateAccountPayload } = require('../../merchant/accountPayload');

const router = express.Router();

router.get('/account', merchantAuthMiddleware, async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.merchantId);
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    return res.status(200).json({
      ok: true,
      merchant: serializeMerchant(merchant),
    });
  } catch (error) {
    console.error('Error fetching merchant account:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.patch('/account', merchantAuthMiddleware, async (req, res) => {
  try {
    const { errors, normalized } = validateAccountPayload(req.body || {}, { partial: true });
    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const merchant = await Merchant.findById(req.merchantId);
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    if (normalized.email !== undefined) merchant.email = normalized.email;
    if (normalized.businessName !== undefined) merchant.businessName = normalized.businessName;
    if (normalized.phone !== undefined) merchant.phone = normalized.phone;
    if (normalized.address !== undefined) merchant.address = normalized.address;

    await merchant.save();

    return res.status(200).json({
      ok: true,
      merchant: serializeMerchant(merchant),
    });
  } catch (error) {
    console.error('Error updating merchant account:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
