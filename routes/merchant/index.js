const express = require('express');

const authRoutes = require('./authRoutes');
const accountRoutes = require('./accountRoutes');

const router = express.Router();

router.use('/merchant/v1', authRoutes);
router.use('/merchant/v1', accountRoutes);

module.exports = router;
