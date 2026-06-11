const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.secretKey = process.env.secretKey || 'split-backend-test-secret';

const { createApp } = require('../app');
const Merchant = require('../models/Merchant');
const merchantSessionHelper = require('../merchant/merchantSessionHelper');

const TEST_PUBKEY = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_ADDRESS = {
  formattedAddress: '123 Main St, Nashville, TN 37201, USA',
  googlePlaceId: 'ChIJ-test-place',
  street: '123 Main St',
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
  lat: 36.1627,
  lng: -86.7816,
};

async function withServer(run) {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a valid address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function maybeWithServer(t, run) {
  try {
    await withServer(run);
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('Local socket binding is not permitted in this environment.');
      return;
    }

    throw error;
  }
}

function withPatchedMethods(patches, fn) {
  const originals = patches.map(({ target, key }) => ({
    target,
    key,
    value: target[key],
  }));

  patches.forEach(({ target, key, value }) => {
    target[key] = value;
  });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      originals.forEach(({ target, key, value }) => {
        target[key] = value;
      });
    });
}

function buildMerchant(overrides = {}) {
  return {
    _id: '665f3a111111111111111111',
    sparkWalletPubkey: TEST_PUBKEY,
    businessName: 'Merchant Coffee',
    email: 'merchant@example.com',
    phone: '+16155550100',
    address: TEST_ADDRESS,
    createdAt: new Date('2026-05-01T12:00:00.000Z'),
    updatedAt: new Date('2026-05-01T12:00:00.000Z'),
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides,
  };
}

function merchantCookie(merchantId = '665f3a111111111111111111', pubkey = TEST_PUBKEY) {
  const token = jwt.sign(
    { type: 'merchant', merchantId, pubkey },
    process.env.secretKey,
    { expiresIn: '1h' }
  );

  return `merchantJwtToken=${token}`;
}

async function fetchNonce(baseUrl) {
  const response = await fetch(`${baseUrl}/merchant/v1/auth/nonce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(body.messageToSign, /domain=merchant\.splitrewards\.app/);

  return body.nonce;
}

test('GET /merchant/v1/breez-api-key returns the Breez key for merchant clients', async (t) => {
  const originalBreezApiKey = process.env.BREEZ_API_KEY;
  process.env.BREEZ_API_KEY = 'test-breez-api-key';

  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/merchant/v1/breez-api-key`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { apiKey: 'test-breez-api-key' });
  });

  if (originalBreezApiKey === undefined) {
    delete process.env.BREEZ_API_KEY;
  } else {
    process.env.BREEZ_API_KEY = originalBreezApiKey;
  }
});

test('GET /merchant/v1/breez-api-key reports server misconfiguration without a Breez key', async (t) => {
  const originalBreezApiKey = process.env.BREEZ_API_KEY;
  delete process.env.BREEZ_API_KEY;

  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/merchant/v1/breez-api-key`);
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Server misconfiguration' });
  });

  if (originalBreezApiKey !== undefined) {
    process.env.BREEZ_API_KEY = originalBreezApiKey;
  }
});

test('POST /merchant/v1/auth/register creates a merchant and sets a merchant cookie', async (t) => {
  const createdPayloads = [];

  await withPatchedMethods([
    {
      target: merchantSessionHelper,
      key: 'verifyBreezSignedMessage',
      value: () => true,
    },
    {
      target: Merchant,
      key: 'findOne',
      value: async () => null,
    },
    {
      target: Merchant,
      key: 'create',
      value: async (payload) => {
        createdPayloads.push(payload);
        return buildMerchant(payload);
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const nonce = await fetchNonce(baseUrl);
      const response = await fetch(`${baseUrl}/merchant/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pubkey: TEST_PUBKEY.toUpperCase(),
          nonce,
          signature: 'deadbeef',
          iat: 1770000000,
          businessName: ' Test Coffee ',
          email: ' Merchant@Example.COM ',
          phone: ' +16155550100 ',
          address: TEST_ADDRESS,
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 201);
      assert.equal(body.ok, true);
      assert.equal(body.merchant.merchantId, '665f3a111111111111111111');
      assert.equal(body.merchant.businessName, 'Test Coffee');
      assert.equal(body.merchant.email, 'merchant@example.com');
      assert.equal(body.merchant.phone, '+16155550100');
      assert.deepEqual(body.merchant.address, TEST_ADDRESS);
      assert.equal(body.merchant.sparkWalletPubkey, TEST_PUBKEY);
      assert.match(response.headers.get('set-cookie') || '', /merchantJwtToken=/);
      assert.equal(createdPayloads.length, 1);
      assert.equal(createdPayloads[0].sparkWalletPubkey, TEST_PUBKEY);
    });
  });
});

test('POST /merchant/v1/auth/register requires Google address coordinates', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/merchant/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pubkey: TEST_PUBKEY,
        nonce: 'nonce',
        signature: 'signature',
        businessName: 'Merchant',
        email: 'merchant@example.com',
        phone: '+16155550100',
        address: {
          formattedAddress: TEST_ADDRESS.formattedAddress,
          googlePlaceId: TEST_ADDRESS.googlePlaceId,
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid request');
    assert.ok(body.details.includes('address.lat is invalid'));
    assert.ok(body.details.includes('address.lng is invalid'));
  });
});

test('POST /merchant/v1/auth/wallet-login rejects unknown merchant pubkeys', async (t) => {
  await withPatchedMethods([
    {
      target: merchantSessionHelper,
      key: 'verifyBreezSignedMessage',
      value: () => true,
    },
    {
      target: Merchant,
      key: 'findOne',
      value: async () => null,
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const nonce = await fetchNonce(baseUrl);
      const response = await fetch(`${baseUrl}/merchant/v1/auth/wallet-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pubkey: TEST_PUBKEY,
          nonce,
          signature: 'deadbeef',
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 404);
      assert.equal(body.error, 'Merchant not found');
    });
  });
});

test('GET /merchant/v1/session returns the authenticated merchant account', async (t) => {
  await withPatchedMethods([
    {
      target: Merchant,
      key: 'findById',
      value: async () => buildMerchant(),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/merchant/v1/session`, {
        headers: { cookie: merchantCookie() },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.merchant.merchantId, '665f3a111111111111111111');
      assert.equal(body.merchant.sparkWalletPubkey, TEST_PUBKEY);
    });
  });
});

test('PATCH /merchant/v1/account updates only merchant profile fields', async (t) => {
  const merchant = buildMerchant();

  await withPatchedMethods([
    {
      target: Merchant,
      key: 'findById',
      value: async () => merchant,
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/merchant/v1/account`, {
        method: 'PATCH',
        headers: {
          cookie: merchantCookie(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: 'new@example.com',
          businessName: 'Updated Merchant',
          address: {
            formattedAddress: '500 Broadway, Nashville, TN 37203, USA',
            googlePlaceId: 'ChIJ-new-place',
            street: '500 Broadway',
            city: 'Nashville',
            state: 'TN',
            postalCode: '37203',
            lat: 36.1592,
            lng: -86.7785,
          },
          sparkWalletPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.merchant.businessName, 'Updated Merchant');
      assert.equal(body.merchant.email, 'new@example.com');
      assert.equal(body.merchant.phone, '+16155550100');
      assert.equal(body.merchant.address.googlePlaceId, 'ChIJ-new-place');
      assert.equal(body.merchant.sparkWalletPubkey, TEST_PUBKEY);
      assert.equal(merchant.saveCalls, 1);
    });
  });
});
