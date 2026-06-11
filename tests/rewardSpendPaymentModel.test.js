const test = require('node:test');
const assert = require('node:assert/strict');

const RewardSpendPayment = require('../models/RewardSpendPayment');

function hasUniquePartialStringIndex(indexes, fieldName) {
  return indexes.some(([fields, options]) => (
    fields[fieldName] === 1 &&
    options &&
    options.unique === true &&
    options.partialFilterExpression?.[fieldName]?.$type === 'string'
  ));
}

test('RewardSpendPayment keeps legacy and hashed payment identifiers unique when present', () => {
  const indexes = RewardSpendPayment.schema.indexes();

  assert.equal(hasUniquePartialStringIndex(indexes, 'paymentHash'), true);
  assert.equal(hasUniquePartialStringIndex(indexes, 'paymentHashHash'), true);
});

test('RewardSpendPayment supports current hashed merchant fields without requiring raw pubkeys', () => {
  const paths = RewardSpendPayment.schema.paths;

  assert.equal(Boolean(paths.destinationPubkey?.isRequired), false);
  assert.equal(Boolean(paths.merchantPubkeyHash?.isRequired), false);
  assert.equal(Boolean(paths.paymentHashHash?.isRequired), false);
});
