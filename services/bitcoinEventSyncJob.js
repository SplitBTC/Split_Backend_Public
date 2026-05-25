const cron = require('node-cron');

const BitcoinEvent = require('../models/BitcoinEvent');
const lumaEventImporter = require('./lumaEventImporter');

const BITCOIN_EVENT_REFRESH_CRON = '0 */6 * * *';
const BITCOIN_EVENT_REFRESH_CONCURRENCY = 3;

let bitcoinEventRefreshTask = null;
let isBitcoinEventRefreshRunning = false;

function buildUpcomingLumaBitcoinEventsQuery(now = new Date()) {
  return {
    source: 'luma',
    sourceUrl: { $exists: true, $ne: '' },
    country: 'US',
    $or: [
      { endsAt: { $gt: now } },
      {
        endsAt: null,
        startsAt: { $gt: now },
      },
    ],
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return;
  }

  const workerCount = Math.max(
    1,
    Math.min(Number(concurrency) || 1, items.length)
  );
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }));
}

async function findEventsToRefresh({ eventModel, now }) {
  return eventModel.find(buildUpcomingLumaBitcoinEventsQuery(now))
    .select('_id sourceUrl title startsAt externalEventId')
    .sort({ startsAt: 1, _id: 1 })
    .lean();
}

async function refreshUpcomingBitcoinEvents(options = {}) {
  const eventModel = options.eventModel || BitcoinEvent;
  const importer = options.importer || lumaEventImporter;
  const logger = options.logger || console;
  const now = options.now || new Date();
  const concurrency = options.concurrency || BITCOIN_EVENT_REFRESH_CONCURRENCY;

  if (isBitcoinEventRefreshRunning) {
    logger.info?.('Bitcoin event refresh skipped because a refresh is already running.');
    return {
      total: 0,
      refreshed: 0,
      failed: 0,
      skipped: true,
    };
  }

  isBitcoinEventRefreshRunning = true;

  try {
    const events = await findEventsToRefresh({ eventModel, now });
    const result = {
      total: events.length,
      refreshed: 0,
      failed: 0,
      skipped: false,
    };

    await mapWithConcurrency(events, concurrency, async (event) => {
      try {
        await importer.importLumaEventFromUrl(event.sourceUrl);
        result.refreshed += 1;
      } catch (error) {
        result.failed += 1;
        logger.warn?.(
          `Bitcoin event refresh failed for ${event.sourceUrl || event._id}:`,
          error
        );
      }
    });

    if (result.total > 0 || result.failed > 0) {
      logger.info?.(
        `Bitcoin event refresh complete: ${result.refreshed}/${result.total} refreshed, ${result.failed} failed.`
      );
    }

    return result;
  } finally {
    isBitcoinEventRefreshRunning = false;
  }
}

function startBitcoinEventSyncJob(options = {}) {
  if (bitcoinEventRefreshTask) {
    return bitcoinEventRefreshTask;
  }

  const logger = options.logger || console;
  const cronExpression = options.cronExpression || BITCOIN_EVENT_REFRESH_CRON;
  const concurrency = options.concurrency || BITCOIN_EVENT_REFRESH_CONCURRENCY;

  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid Bitcoin event refresh cron expression: ${cronExpression}`);
  }

  const runRefresh = async () => {
    try {
      await refreshUpcomingBitcoinEvents({
        logger,
        concurrency,
      });
    } catch (error) {
      logger.error?.('Bitcoin event refresh failed:', error);
    }
  };

  void runRefresh();
  bitcoinEventRefreshTask = cron.schedule(cronExpression, runRefresh);
  logger.info?.('Bitcoin event refresh scheduled every 6 hours.');

  return bitcoinEventRefreshTask;
}

module.exports = {
  BITCOIN_EVENT_REFRESH_CONCURRENCY,
  BITCOIN_EVENT_REFRESH_CRON,
  buildUpcomingLumaBitcoinEventsQuery,
  refreshUpcomingBitcoinEvents,
  startBitcoinEventSyncJob,
};
