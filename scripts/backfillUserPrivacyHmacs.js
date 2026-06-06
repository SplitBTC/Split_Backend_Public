require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const { buildUserPrivacyFields } = require('../services/userPrivacy');

function buildUserPrivacyBackfillUpdate(user, options = {}) {
  const fields = buildUserPrivacyFields({
    walletPubkey: user?.walletPubkey,
    sparkAddress: user?.sparkAddress,
    lightningAddress: user?.lightningAddress,
  }, {
    ...options,
    requirePepper: true,
  });

  const $set = {};
  for (const [key, value] of Object.entries(fields)) {
    if (user?.[key] !== value) {
      $set[key] = value;
    }
  }

  return Object.keys($set).length ? { $set } : null;
}

function parseArgs(argv) {
  return {
    write: argv.includes('--write'),
    limit: Number.parseInt(
      argv.find((entry) => entry.startsWith('--limit='))?.split('=')[1] || '',
      10
    ) || null,
  };
}

async function backfillUserPrivacyHmacs({
  UserModel = User,
  dryRun = true,
  limit = null,
  logger = console,
} = {}) {
  const query = {
    $or: [
      { walletPubkey: { $exists: true, $ne: null } },
      { sparkAddress: { $exists: true, $ne: null } },
      { lightningAddress: { $exists: true, $ne: null } },
    ],
  };

  let scannedCount = 0;
  let updateCount = 0;
  let skippedCount = 0;
  const errors = [];

  const cursor = UserModel.find(query)
    .select(
      '_id walletPubkey sparkAddress lightningAddress ' +
      'walletPubkeyUserHmac walletPubkeyUserHmacVersion ' +
      'sparkAddressUserHmac sparkAddressUserHmacVersion ' +
      'lightningAddressUserHmac lightningAddressUserHmacVersion'
    )
    .cursor();

  for await (const user of cursor) {
    if (limit && scannedCount >= limit) {
      break;
    }

    scannedCount += 1;

    let update = null;
    try {
      update = buildUserPrivacyBackfillUpdate(user);
    } catch (error) {
      errors.push({
        userId: String(user?._id || ''),
        error: error.message,
      });
      skippedCount += 1;
      continue;
    }

    if (!update) {
      skippedCount += 1;
      continue;
    }

    updateCount += 1;
    if (!dryRun) {
      await UserModel.updateOne({ _id: user._id }, update);
    }
  }

  const result = {
    dryRun,
    scannedCount,
    updateCount,
    skippedCount,
    errorCount: errors.length,
    errors,
  };

  logger.info('User privacy HMAC backfill result:', JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const { write, limit } = parseArgs(process.argv.slice(2));
  const mongoUri = process.env.mongo_DB;
  if (!mongoUri) {
    throw new Error('mongo_DB is required');
  }

  await mongoose.connect(mongoUri);
  try {
    await backfillUserPrivacyHmacs({
      dryRun: !write,
      limit,
    });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('User privacy HMAC backfill failed:', error);
    try {
      await mongoose.disconnect();
    } catch (_disconnectError) {
      // Ignore shutdown errors.
    }
    process.exit(1);
  });
}

module.exports = {
  backfillUserPrivacyHmacs,
  buildUserPrivacyBackfillUpdate,
};
