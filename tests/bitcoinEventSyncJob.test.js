const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpcomingLumaBitcoinEventsQuery,
  refreshUpcomingBitcoinEvents,
} = require('../services/bitcoinEventSyncJob');

function createEventModel(events, calls = {}) {
  return {
    find(query) {
      calls.query = query;

      return {
        select(fields) {
          calls.select = fields;
          return this;
        },
        sort(sortSpec) {
          calls.sort = sortSpec;
          return this;
        },
        async lean() {
          return events;
        },
      };
    },
  };
}

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test('buildUpcomingLumaBitcoinEventsQuery selects future US Luma events with source URLs', () => {
  const now = new Date('2026-04-16T12:00:00.000Z');
  const query = buildUpcomingLumaBitcoinEventsQuery(now);

  assert.equal(query.source, 'luma');
  assert.deepEqual(query.sourceUrl, { $exists: true, $ne: '' });
  assert.equal(query.country, 'US');
  assert.deepEqual(query.$or, [
    { endsAt: { $gt: now } },
    {
      endsAt: null,
      startsAt: { $gt: now },
    },
  ]);
});

test('refreshUpcomingBitcoinEvents refreshes every matching event and keeps going after failures', async () => {
  const events = [
    { _id: 'event-a', sourceUrl: 'https://luma.com/a' },
    { _id: 'event-b', sourceUrl: 'https://luma.com/b' },
    { _id: 'event-c', sourceUrl: 'https://luma.com/c' },
  ];
  const calls = {};
  const importedUrls = [];
  const warnings = [];

  const result = await refreshUpcomingBitcoinEvents({
    eventModel: createEventModel(events, calls),
    importer: {
      async importLumaEventFromUrl(url) {
        importedUrls.push(url);
        if (url === 'https://luma.com/b') {
          throw new Error('Luma unavailable');
        }
      },
    },
    logger: {
      info() {},
      warn(...args) {
        warnings.push(args);
      },
    },
    now: new Date('2026-04-16T12:00:00.000Z'),
    concurrency: 2,
  });

  assert.deepEqual(importedUrls.sort(), [
    'https://luma.com/a',
    'https://luma.com/b',
    'https://luma.com/c',
  ]);
  assert.deepEqual(calls.sort, { startsAt: 1, _id: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.refreshed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, false);
  assert.equal(warnings.length, 1);
});

test('refreshUpcomingBitcoinEvents skips overlapping runs', async () => {
  let releaseImport;
  let markImportStarted;
  const importStarted = new Promise((resolve) => {
    markImportStarted = resolve;
  });

  const firstRefresh = refreshUpcomingBitcoinEvents({
    eventModel: createEventModel([
      { _id: 'event-a', sourceUrl: 'https://luma.com/a' },
    ]),
    importer: {
      async importLumaEventFromUrl() {
        markImportStarted();
        await new Promise((resolve) => {
          releaseImport = resolve;
        });
      },
    },
    logger: createSilentLogger(),
    concurrency: 1,
  });

  await importStarted;

  const overlappingRefresh = await refreshUpcomingBitcoinEvents({
    eventModel: createEventModel([]),
    importer: {
      async importLumaEventFromUrl() {
        throw new Error('overlapping refresh should not import');
      },
    },
    logger: createSilentLogger(),
  });

  assert.equal(overlappingRefresh.skipped, true);
  assert.equal(overlappingRefresh.total, 0);

  releaseImport();
  const firstResult = await firstRefresh;
  assert.equal(firstResult.refreshed, 1);
});
