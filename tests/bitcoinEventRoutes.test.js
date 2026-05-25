const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-google-key';

const express = require('express');
const cookieParser = require('cookie-parser');

const BitcoinEvent = require('../models/BitcoinEvent');
const googleMapsAddressValidation = require('../services/googleMapsAddressValidation');
const BitcoinEventRoutes = require('../routes/BitcoinEventRoutes');

function createJsonApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(BitcoinEventRoutes);
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

function buildEvent(overrides = {}) {
  return {
    _id: overrides._id || 'event-1',
    source: 'luma',
    sourceUrl: overrides.sourceUrl || 'https://luma.com/sample123',
    externalEventId: overrides.externalEventId || 'evt-sample123',
    title: overrides.title || 'Bitcoin Meetup at PubKey',
    description: overrides.description || 'Come talk Bitcoin.',
    coverImageUrl: overrides.coverImageUrl || 'https://images.lumacdn.com/event-covers/sample.png',
    hostName: overrides.hostName || 'PubKey',
    startsAt: overrides.startsAt || new Date('2026-05-01T22:00:00.000Z'),
    endsAt: overrides.endsAt || new Date('2026-05-02T00:00:00.000Z'),
    timezone: overrides.timezone || 'America/New_York',
    venueName: overrides.venueName || 'PubKey',
    address: overrides.address || 'PubKey, 85 Washington Pl, New York, NY 10011, USA',
    city: overrides.city || 'New York',
    region: overrides.region || 'NY',
    postalCode: overrides.postalCode || '10011',
    country: 'US',
    latitude: overrides.latitude ?? 40.7322184,
    longitude: overrides.longitude ?? -74.0000245,
    createdAt: overrides.createdAt || new Date('2026-04-16T00:00:00.000Z'),
    updatedAt: overrides.updatedAt || new Date('2026-04-16T00:00:00.000Z'),
  };
}

function patchBitcoinEventFind(events, calls) {
  return {
    target: BitcoinEvent,
    key: 'find',
    value: (query) => ({
      sort(sortSpec) {
        calls.push({ query, sortSpec });
        return {
          lean: async () => events,
        };
      },
    }),
  };
}

test('GET /v1/bitcoin-events splits nearby and more events from device coordinates', async (t) => {
  const findCalls = [];
  const events = [
    buildEvent({ _id: 'nearby-event', latitude: 38.9072, longitude: -77.0369 }),
    buildEvent({
      _id: 'more-event',
      sourceUrl: 'https://luma.com/vegas123',
      externalEventId: 'evt-vegas123',
      title: 'Bitcoin Event in Las Vegas',
      city: 'Las Vegas',
      region: 'NV',
      postalCode: '89109',
      latitude: 36.1226597,
      longitude: -115.1700866,
    }),
  ];

  await withPatchedMethods([
    patchBitcoinEventFind(events, findCalls),
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/v1/bitcoin-events?latitude=38.9072&longitude=-77.0369`
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.radiusMiles, 25);
      assert.equal(body.searchOrigin.source, 'device');
      assert.equal(body.nearbyEvents.length, 1);
      assert.equal(body.nearbyEvents[0].id, 'nearby-event');
      assert.equal(body.nearbyEvents[0].distanceMiles, 0);
      assert.equal(body.moreEvents.length, 1);
      assert.equal(body.moreEvents[0].id, 'more-event');
      assert.equal(findCalls.length, 1);
      assert.equal(findCalls[0].query.country, 'US');
      assert.deepEqual(findCalls[0].sortSpec, { startsAt: 1, _id: 1 });
    });
  });
});

test('GET /v1/bitcoin-events resolves a ZIP code before splitting events', async (t) => {
  const findCalls = [];

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
      }),
    },
    patchBitcoinEventFind([], findCalls),
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/bitcoin-events?zip=20001`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.searchOrigin.source, 'postalCode');
      assert.equal(body.searchOrigin.postalCode, '20001');
      assert.deepEqual(body.nearbyEvents, []);
      assert.deepEqual(body.moreEvents, []);
      assert.equal(findCalls.length, 1);
    });
  });
});

test('GET /v1/bitcoin-events returns all future events in moreEvents without a search origin', async (t) => {
  const findCalls = [];
  const events = [buildEvent({ _id: 'national-event' })];

  await withPatchedMethods([
    patchBitcoinEventFind(events, findCalls),
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/bitcoin-events`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.searchOrigin, null);
      assert.deepEqual(body.nearbyEvents, []);
      assert.equal(body.moreEvents.length, 1);
      assert.equal(body.moreEvents[0].id, 'national-event');
      assert.equal(body.moreEvents[0].distanceMiles, null);
      assert.equal(findCalls.length, 1);
    });
  });
});
