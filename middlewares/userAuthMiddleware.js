const jwt = require('jsonwebtoken');

function getJwtSecretKey() {
  return process.env.secretKey;
}

// User authentication middleware
const userAuthMiddleware = (req, res, next) => {
  try {
    // Get token from cookies
    const token = req.cookies.jwtToken;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized - No token' });
    }

    // Verify the token
    const decoded = jwt.verify(token, getJwtSecretKey());

    // Extract userId from the decoded token
    const userId = decoded.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    // Attach only the stable user id. Legacy cookies may still include pubkey until expiry.
    req.userId = userId;

    // Proceed to the next middleware or route handler
    next();
  } catch (error) {
    console.error("Error verifying user token:", error);
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
};

module.exports = userAuthMiddleware;
