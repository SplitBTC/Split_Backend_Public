const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.secretKey = process.env.secretKey || 'split-backend-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
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

function authCookie(userId, pubkey = null) {
  const token = jwt.sign(
    pubkey ? { userId, pubkey } : { userId },
    process.env.secretKey,
    { expiresIn: '1h' }
  );

  return `jwtToken=${token}`;
}

function queryResult(value) {
  return {
    select: async () => value,
  };
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

function currentRedemptionMonth(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

test('POST /v1/merchant-coupons/:couponId/redeem creates a redemption for the current UTC month', async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const couponId = new mongoose.Types.ObjectId().toString();
  const createCalls = [];
  const couponQueries = [];
  const redeemedAt = new Date('2026-04-14T16:20:00.000Z');

  await withPatchedMethods([
    {
      target: Coupon,
      key: 'findOne',
      value: (filter) => {
        couponQueries.push(filter);
        return queryResult({ _id: couponId });
      },
    },
    {
      target: CouponRedemption,
      key: 'create',
      value: async (payload) => {
        createCalls.push(payload);
        return {
          _id: new mongoose.Types.ObjectId(),
          ...payload,
          redeemedAt,
        };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/merchant-coupons/${couponId}/redeem`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(userId),
          'Content-Type': 'application/json',
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didRedeem, true);
      assert.equal(body.alreadyRedeemedThisMonth, false);
      assert.equal(body.redemptionMonth, currentRedemptionMonth());
      assert.equal(body.redeemedAt, redeemedAt.toISOString());
      assert.equal(couponQueries.length, 1);
      assert.deepEqual(couponQueries[0], { _id: couponId, status: 'approved' });
      assert.equal(createCalls.length, 1);
      assert.equal(createCalls[0].couponId, couponId);
      assert.equal(createCalls[0].userId, userId);
      assert.equal(createCalls[0].redemptionMonth, currentRedemptionMonth());
      assert.ok(createCalls[0].redeemedAt instanceof Date);
    });
  });
});

test('POST /v1/merchant-coupons/:couponId/redeem returns already redeemed when a redemption exists for the current UTC month', async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const couponId = new mongoose.Types.ObjectId().toString();
  const redeemedAt = new Date('2026-04-14T16:20:00.000Z');
  const findOneQueries = [];

  await withPatchedMethods([
    {
      target: Coupon,
      key: 'findOne',
      value: () => queryResult({ _id: couponId }),
    },
    {
      target: CouponRedemption,
      key: 'create',
      value: async () => {
        const error = new Error('Duplicate redemption');
        error.code = 11000;
        throw error;
      },
    },
    {
      target: CouponRedemption,
      key: 'findOne',
      value: (filter) => {
        findOneQueries.push(filter);
        return queryResult({ redeemedAt });
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/merchant-coupons/${couponId}/redeem`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(userId),
          'Content-Type': 'application/json',
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didRedeem, false);
      assert.equal(body.alreadyRedeemedThisMonth, true);
      assert.equal(body.redemptionMonth, currentRedemptionMonth());
      assert.equal(body.redeemedAt, redeemedAt.toISOString());
      assert.equal(findOneQueries.length, 1);
      assert.deepEqual(findOneQueries[0], {
        couponId,
        userId,
        redemptionMonth: currentRedemptionMonth(),
      });
    });
  });
});

test('POST /v1/merchant-coupons/:couponId/redeem returns 404 when the coupon is unavailable', async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const couponId = new mongoose.Types.ObjectId().toString();
  let createCalled = false;

  await withPatchedMethods([
    {
      target: Coupon,
      key: 'findOne',
      value: () => queryResult(null),
    },
    {
      target: CouponRedemption,
      key: 'create',
      value: async () => {
        createCalled = true;
        return null;
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/merchant-coupons/${couponId}/redeem`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(userId),
          'Content-Type': 'application/json',
        },
      });

      const body = await response.json();

      assert.equal(response.status, 404);
      assert.equal(body.error, 'Coupon not found');
      assert.equal(createCalled, false);
    });
  });
});
