const crypto = require('crypto');
const http2 = require('http2');
const fs = require('fs');

const APNS_TOPIC = process.env.APNS_TOPIC || 'com.example.app';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY || '';
const APNS_PRIVATE_KEY_PATH = process.env.APNS_PRIVATE_KEY_PATH || '';
const APNS_USE_SANDBOX = String(process.env.APNS_USE_SANDBOX || '').toLowerCase() === 'true';

let cachedJwt = null;
let cachedJwtExpiresAt = 0;
let warnedMissingConfig = false;

function getApnsOrigin() {
  return APNS_USE_SANDBOX
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
}

function loadPrivateKey() {
  if (APNS_PRIVATE_KEY.trim()) {
    return normalizePrivateKey(APNS_PRIVATE_KEY);
  }

  if (APNS_PRIVATE_KEY_PATH.trim()) {
    return normalizePrivateKey(fs.readFileSync(APNS_PRIVATE_KEY_PATH.trim(), 'utf8'));
  }

  return null;
}

function normalizePrivateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  let normalized = raw.replace(/\\n/g, '\n');

  // If the env provider flattened the PEM onto one line, rebuild the expected newlines.
  normalized = normalized
    .replace(/-----BEGIN PRIVATE KEY-----\s*/g, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/\s*-----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----');

  // Trim whitespace around each line while preserving the PEM structure.
  normalized = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

  return normalized;
}

function hasApnsConfig() {
  return Boolean(
    APNS_TOPIC.trim() &&
    APNS_KEY_ID.trim() &&
    APNS_TEAM_ID.trim() &&
    loadPrivateKey()
  );
}

function getProviderToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now < cachedJwtExpiresAt) {
    return cachedJwt;
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    throw new Error('Missing APNS private key');
  }

  const header = {
    alg: 'ES256',
    kid: APNS_KEY_ID.trim(),
  };

  const payload = {
    iss: APNS_TEAM_ID.trim(),
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const joseSignatureBytes = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  const token = `${signingInput}.${base64UrlEncode(joseSignatureBytes)}`;

  cachedJwt = token;
  cachedJwtExpiresAt = now + (50 * 60);
  return token;
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sendSilentMessagePush({
  deviceToken,
  conversationId,
  messageId,
  pushType = 'messaging.new_message',
}) {
  const normalizedToken = String(deviceToken || '').trim().toLowerCase();
  if (!normalizedToken) {
    return { ok: false, skipped: true, reason: 'missing-device-token' };
  }

  if (!hasApnsConfig()) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn('APNS not configured; messaging pushes are disabled.');
    }
    return { ok: false, skipped: true, reason: 'missing-apns-config' };
  }

  const client = http2.connect(getApnsOrigin());

  try {
    const token = getProviderToken();
    const isVisibleMessagePush = pushType === 'messaging.new_message';
    const payload = isVisibleMessagePush
      ? {
          aps: {
            alert: {
              title: 'Split',
              body: 'New message',
            },
            sound: 'default',
            'content-available': 1,
          },
          type: pushType,
          conversationId,
          messageId: String(messageId || ''),
        }
      : {
          aps: {
            'content-available': 1,
          },
          type: pushType,
          conversationId,
          messageId: String(messageId || ''),
        };

    const response = await new Promise((resolve, reject) => {
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${normalizedToken}`,
        authorization: `bearer ${token}`,
        'apns-push-type': isVisibleMessagePush ? 'alert' : 'background',
        'apns-priority': isVisibleMessagePush ? '10' : '5',
        'apns-topic': APNS_TOPIC,
      });

      let responseBody = '';
      let responseHeaders = null;

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        responseHeaders = headers;
      });
      request.on('data', (chunk) => {
        responseBody += chunk;
      });
      request.on('end', () => {
        const statusCode = Number(responseHeaders?.[':status'] || 0);
        if (statusCode >= 200 && statusCode < 300) {
          resolve({ ok: true, statusCode, body: responseBody });
        } else {
          resolve({ ok: false, statusCode, body: responseBody });
        }
      });
      request.on('error', reject);

      request.end(JSON.stringify(payload));
    });

    return response;
  } finally {
    client.close();
  }
}

module.exports = {
  sendSilentMessagePush,
};
