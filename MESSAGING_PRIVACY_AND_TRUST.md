# Split Messaging Privacy and Trust

This document describes the current Split messaging system.

## Summary

Split messaging provides:

- end-to-end encryption for message bodies
- client-side encryption for attachments before upload
- wallet-signed binding between wallet pubkey, Lightning address, and messaging pubkey
- client verification of recipient directory proofs
- signed APNs/FCM device registration
- relay cleanup for acknowledged, expired, failed, and received items

Split messaging does not currently provide:

- metadata privacy from the Split relay
- independent directory witnesses
- Signal-style double-ratchet forward secrecy
- deniable authentication
- censorship resistance

Short version:

> Split messaging is authenticated end-to-end encrypted messaging with a client-verified server directory and visible relay metadata.

## Identity

Each messaging identity contains:

- `walletPubkey`
- `lightningAddress`
- `messagingPubkey`
- `messagingIdentitySignature`
- `messagingIdentitySignatureVersion`
- `messagingIdentitySignedAt`

The mobile client creates or restores the messaging key locally. The wallet signs the identity binding locally. The backend verifies that wallet signature before accepting the binding.

Accepted bindings are stored on the user record and appended to the messaging directory log.

## Directory

Recipients are resolved through `/messaging/v3/directory/lookup`.

The backend returns the recipient's wallet-signed binding, a Merkle inclusion proof, and a checkpoint containing `rootHash`, `treeSize`, and `issuedAt`.

The client verifies the binding and proof before using the recipient messaging key.

Important limit: Split operates the directory. There is no external witness, gossip system, or public transparency monitor today.

## Messages

Messages are sent through `/messaging/v3/send` and fetched through `/messaging/v3/inbox`.

The backend enforces:

- authenticated session
- active sender messaging identity
- valid recipient wallet-signed binding
- recipient binding freshness
- block-list checks
- duplicate `clientMessageId` handling
- attachment ownership checks

For current sealed envelopes, the relay stores routing metadata plus ciphertext, nonce, sender ephemeral pubkey, message type, and expiry. The plaintext body is inside the encrypted payload.

Older non-sealed sends also include a sender envelope signature that the backend verifies before storing the relay message.

After local processing, clients acknowledge messages through `/messaging/v3/ack`. Acknowledged pending messages are deleted from the relay.

Clients can report delivery problems through `/messaging/v3/decrypt-failed` and `/messaging/v3/rekey-required`. Senders can check status through `/messaging/v3/outgoing-statuses`.

## Push

Device registrations use `/messaging/v3/device-registrations`.

The wallet signs the registration over wallet pubkey, active messaging pubkey, platform, environment, device token, and timestamp.

APNs new-message pushes show a generic notification:

- title: `Split`
- body: `New message`

FCM pushes use data payloads. Push payloads do not include message plaintext, but Apple and Google still see push delivery metadata.

## Attachments

Attachments are encrypted by the client before upload.

The backend stores encrypted bytes and metadata: sender, recipient, object key, size, content type, status, and expiry.

Attachment decryption material is carried inside the encrypted message payload. Attachments are deleted when marked received or when they expire.

## What Split Can See

Split still sees relay metadata:

- authenticated sender and recipient accounts
- wallet pubkeys and Lightning addresses
- recipient lookups
- sender/recipient graph
- message timing and type
- ciphertext length
- attachment existence and size
- push token registration
- message acknowledgements
- attachment downloads and receipt markers

This is not a metadata-private messaging system.

## What Split Should Not See

For correctly implemented current clients, Split should not see:

- message plaintext
- plaintext attachment bytes
- local messaging private keys
- attachment decryption material

These protections still depend on client correctness and device security.

## Retention

Split messaging is a store-and-forward relay.

Current backend behavior:

- pending messages remain until acknowledged or expired
- acknowledged pending messages are deleted
- expired pending messages are marked `undelivered`
- expired, rekeyed, and failed messages have ciphertext, nonce, and sender ephemeral key removed
- delivered receipts are pruned after a shorter retention window
- non-delivered receipts are pruned after the normal receipt retention window
- uploaded or linked attachments expire on schedule
- received, deleted, and expired attachment records are later pruned

## Trust Boundaries

Strong properties:

- The wallet authorizes the identity binding.
- The client verifies recipient directory proofs.
- The relay should not receive message plaintext or plaintext attachment bytes.
- The backend does not back up local messaging private keys.

Remaining trust:

- Split controls relay availability.
- Split controls directory freshness.
- Split can delay, drop, censor, or replay relay ciphertext it already has.
- Split can observe messaging metadata.
- There is no independent witness for split-view directory behavior.
- A compromised unlocked device can expose local state.

## Not Claimed

Do not describe Split messaging as anonymous, metadata-private, witness-backed, transparency-audited, deniable, Signal-compatible, double-ratchet forward-secret, or censorship-resistant.

## Bottom Line

Split messaging is stronger than server-trusted chat because message content is encrypted client-side and identity is wallet-bound.

It is still a visible relay. Split learns metadata, controls availability, and currently operates the directory without external witnesses.
