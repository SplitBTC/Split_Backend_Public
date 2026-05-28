const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeBolt11 } = require('../rewards/bolt11Invoice');

const donationInvoice = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const coffeeInvoice = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';

test('decodeBolt11 recovers destination pubkey and payment hash', () => {
  const metadata = decodeBolt11(donationInvoice);

  assert.equal(metadata.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
  assert.equal(metadata.destinationPubkey, '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad');
  assert.equal(metadata.amountSats, null);
});

test('decodeBolt11 parses fixed invoice amount', () => {
  const metadata = decodeBolt11(coffeeInvoice);

  assert.equal(metadata.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
  assert.equal(metadata.destinationPubkey, '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad');
  assert.equal(metadata.amountSats, 250000);
});

test('decodeBolt11 rejects invalid checksums', () => {
  assert.equal(decodeBolt11(`${donationInvoice.slice(0, -1)}x`), null);
});
