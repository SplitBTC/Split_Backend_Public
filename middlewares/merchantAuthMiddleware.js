const jwt = require('jsonwebtoken');

function getJwtSecretKey() {
  return process.env.secretKey;
}

const merchantAuthMiddleware = (req, res, next) => {
  try {
    const token = req.cookies.merchantJwtToken;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized - No token' });
    }

    const decoded = jwt.verify(token, getJwtSecretKey());
    if (decoded.type !== 'merchant' || !decoded.merchantId) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    req.merchantId = decoded.merchantId;
    if (decoded.pubkey) {
      req.pubkey = decoded.pubkey;
    }

    next();
  } catch (error) {
    console.error('Error verifying merchant token:', error);
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
};

module.exports = merchantAuthMiddleware;
