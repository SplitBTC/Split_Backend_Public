const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-google-key';
process.env.secretKey = process.env.secretKey || 'split-backend-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const googleMapsAddressValidation = require('../services/googleMapsAddressValidation');
const iOSEndPoints = require('../routes/iOSEndPoints');

function createJsonApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(iOSEndPoints);
  return app;
}

async function withServer(run) {
  const app = createJsonApp();
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

function authCookie(userId, pubkey = null) {
  const token = jwt.sign(
    pubkey ? { userId, pubkey } : { userId },
    process.env.secretKey,
    { expiresIn: '1h' }
  );

  return `jwtToken=${token}`;
}

test('GET /v1/merchant-coupons/nearby returns approved coupons nearest to coordinates', async (t) => {
  const aggregateCalls = [];

  await withPatchedMethods([
    {
      target: Coupon,
      key: 'aggregate',
      value: async (pipeline) => {
        aggregateCalls.push(pipeline);
        return [
          {
            _id: 'coupon-1',
            businessName: 'Split Cafe',
            businessLogoUrl: 'https://cdn.example.com/merchant-coupons/logos/cafe.png',
            dealDescription: 'Large latte and pastry for $8 every weekday.',
            appliesToAllLocations: true,
            primaryBusinessAddress: {
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
            },
            distanceMeters: 8046.72,
          },
        ];
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/v1/merchant-coupons/nearby?latitude=38.9072&longitude=-77.0369&radiusMiles=25`
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.searchOrigin.source, 'device');
      assert.equal(body.coupons.length, 1);
      assert.equal(body.coupons[0].businessName, 'Split Cafe');
      assert.equal(body.coupons[0].distanceMiles, 5);
      assert.equal(aggregateCalls.length, 1);
      assert.deepEqual(
        aggregateCalls[0][0].$geoNear.near.coordinates,
        [-77.0369, 38.9072]
      );
      assert.equal(aggregateCalls[0][0].$geoNear.maxDistance, 25 * 1609.344);
      assert.deepEqual(aggregateCalls[0][0].$geoNear.query, { status: 'approved' });
    });
  });
});

test('GET /v1/merchant-coupons/nearby resolves a ZIP code before querying approved coupons', async (t) => {
  const aggregateCalls = [];

  await withPatchedMethods([
    {
      target: googleMapsAddressValidation,
      key: 'resolveUsPostalCodeSearchOrigin',
      value: async (postalCode) => ({
        formattedAddress: 'Washington, DC 20001, USA',
        postalCode,
        city: 'Washington',
        state: 'DC',
        countryCode: 'US',
        latitude: 38.9072,
        longitude: -77.0369,
        geoPoint: {
          type: 'Point',
          coordinates: [-77.0369, 38.9072],
        },
      }),
    },
    {
      target: Coupon,
      key: 'aggregate',
      value: async (pipeline) => {
        aggregateCalls.push(pipeline);
        return [];
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/v1/merchant-coupons/nearby?postalCode=20001`
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.searchOrigin.source, 'postalCode');
      assert.equal(body.searchOrigin.postalCode, '20001');
      assert.deepEqual(body.coupons, []);
      assert.equal(aggregateCalls.length, 1);
      assert.deepEqual(
        aggregateCalls[0][0].$geoNear.near.coordinates,
        [-77.0369, 38.9072]
      );
    });
  });
});

test('GET /v1/merchant-coupons/nearby includes current-user redemption status when authenticated', async (t) => {
  const userId = '680c3ef50000000000000001';

  await withPatchedMethods([
    {
      target: Coupon,
      key: 'aggregate',
      value: async () => [
        {
          _id: '680c3ef500000000000000aa',
          businessName: 'Split Cafe',
          businessLogoUrl: 'https://cdn.example.com/merchant-coupons/logos/cafe.png',
          dealDescription: 'Large latte and pastry for $8 every weekday.',
          appliesToAllLocations: true,
          primaryBusinessAddress: {
            formattedAddress: '123 Main St, Washington, DC 20001, USA',
            line1: '123 Main St',
            line2: '',
            city: 'Washington',
            state: 'DC',
            postalCode: '20001',
            countryCode: 'US',
            placeId: 'place-123',
            latitude: 38.9072,
            longitude: -77.0369,
          },
          distanceMeters: 1609.344,
        },
      ],
    },
    {
      target: CouponRedemption,
      key: 'find',
      value: () => ({
        select() {
          return {
            lean: async () => [
              {
                couponId: '680c3ef500000000000000aa',
                redeemedAt: new Date('2026-04-27T19:26:00.000Z'),
              },
            ],
          };
        },
      }),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/v1/merchant-coupons/nearby?latitude=38.9072&longitude=-77.0369`,
        {
          headers: {
            Cookie: authCookie(userId),
          },
        }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.coupons.length, 1);
      assert.equal(body.coupons[0].hasRedeemedThisMonth, true);
      assert.equal(body.coupons[0].currentUserRedeemedAt, '2026-04-27T19:26:00.000Z');
    });
  });
});
