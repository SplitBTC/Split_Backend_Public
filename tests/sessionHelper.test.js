const test = require('node:test');
const assert = require('node:assert/strict');

const sessionHelper = require('../auth/sessionHelper');

test('sessionHelper keeps wallet auth and account delete nonce purposes separate', () => {
  const authNonce = sessionHelper.issueNonce({
    domain: 'split.test',
    purpose: sessionHelper.WALLET_AUTH_PURPOSE,
  });
  const deleteNonce = sessionHelper.issueNonce({
    domain: 'split.test',
    purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
  });

  assert.match(authNonce.messageToSign, /^SplitRewards Wallet Authentication/);
  assert.match(deleteNonce.messageToSign, /^SplitRewards Account Deletion Authorization/);
  assert.equal(
    sessionHelper.peekNonce(authNonce.nonce, {
      purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
    }),
    null
  );
  assert.equal(
    sessionHelper.peekNonce(deleteNonce.nonce, {
      purpose: sessionHelper.WALLET_AUTH_PURPOSE,
    }),
    null
  );
  assert.equal(
    sessionHelper.consumeNonce(deleteNonce.nonce, {
      purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
    }),
    true
  );
  assert.equal(
    sessionHelper.peekNonce(deleteNonce.nonce, {
      purpose: sessionHelper.ACCOUNT_DELETE_PURPOSE,
    }),
    null
  );
});
