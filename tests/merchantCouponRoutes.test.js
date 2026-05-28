const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createApp } = require('../app');
const Coupon = require('../models/Coupon');
const s3Client = require('../integrations/r2');
const googleMapsAddressValidation = require('../services/googleMapsAddressValidation');

process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-google-key';
process.env.R2_BUCKET = process.env.R2_BUCKET || 'split-test-bucket';

const ONE_BY_ONE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

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

test('GET /create_merchant_coupon renders the public merchant promo form', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/create_merchant_coupon`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Create a Promo/);
    assert.match(body, /action="\/create_merchant_coupon"/);
    assert.match(body, /Primary business address/);
    assert.match(body, /Submit Promo/);
  });
});

test('GET /create_merchant_coupon?submitted=1 renders a clear confirmation state', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/create_merchant_coupon?submitted=1`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Promo submitted\./);
    assert.match(body, /Submission successful/);
    assert.match(body, /What happens next/);
    assert.match(body, /Submit another Promo/);
  });
});

test('POST /create_merchant_coupon validates, uploads, and creates a pending coupon', async (t) => {
  const createdCoupons = [];
  const uploadedCommands = [];

  await withPatchedMethods([
    {
      target: googleMapsAddressValidation,
      key: 'validateUsBusinessAddress',
      value: async () => ({
        formattedAddress: '123 Main St, Washington, DC 20001, USA',
        line1: '123 Main St',
        line2: 'Suite 100',
        city: 'Washington',
        state: 'DC',
        postalCode: '20001',
        countryCode: 'US',
        placeId: 'place-123',
        latitude: 38.9072,
        longitude: -77.0369,
        geoPoint: {
          type: 'Point',
          coordinates: [-77.0369, 38.9072],
        },
      }),
    },
    {
      target: s3Client,
      key: 'send',
      value: async (command) => {
        uploadedCommands.push(command);
        return {};
      },
    },
    {
      target: Coupon,
      key: 'create',
      value: async (payload) => {
        createdCoupons.push(payload);
        return { _id: 'coupon-1', ...payload };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const formData = new FormData();
      formData.set('businessName', 'Split Cafe');
      formData.set('contactEmail', 'merchant@example.com');
      formData.set('dealDescription', 'Large latte and pastry for $8 every weekday.');
      formData.set('addressLine1', '123 Main St');
      formData.set('addressLine2', 'Suite 100');
      formData.set('city', 'Washington');
      formData.set('state', 'DC');
      formData.set('postalCode', '20001');
      formData.set(
        'businessLogo',
        new Blob([Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64')], { type: 'image/png' }),
        'logo.png'
      );

      const response = await fetch(`${baseUrl}/create_merchant_coupon`, {
        method: 'POST',
        body: formData,
        redirect: 'manual',
      });

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/create_merchant_coupon?submitted=1');
      assert.equal(createdCoupons.length, 1);
      assert.equal(uploadedCommands.length, 1);
      assert.equal(createdCoupons[0].businessName, 'Split Cafe');
      assert.equal(createdCoupons[0].status, 'pending');
      assert.equal(createdCoupons[0].appliesToAllLocations, true);
      assert.equal(createdCoupons[0].contactEmail, 'merchant@example.com');
      assert.equal(
        createdCoupons[0].primaryBusinessAddress.formattedAddress,
        '123 Main St, Washington, DC 20001, USA'
      );
      assert.match(createdCoupons[0].businessLogoUrl, /^https:\/\/cdn\.example\.com\/merchant-coupons\/logos\/.+\.png$/);
      assert.match(createdCoupons[0].businessLogoObjectKey, /^merchant-coupons\/logos\/.+\.png$/);
    });
  });
});
