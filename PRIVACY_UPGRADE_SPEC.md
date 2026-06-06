# Split User Data Privacy Upgrade Spec

This document captures the planned privacy upgrade for Split backend identity and messaging metadata.

The goal is to reduce what a database leak reveals, reduce easy joins between core user data and messaging metadata, and keep existing released mobile clients working while new clients move to safer contracts.

This is the design spec for the privacy upgrade.

## Goals

- Store queryable user identifiers as deterministic server-peppered HMAC values.
- Add targeted client hashing for lookup flows where the server does not need the raw value.
- Separate core user identity metadata from messaging metadata with different server peppers.
- Move messaging identity state out of the core `User` document.
- Keep the messaging directory backend-owned.
- Let clients fetch recipient bindings so they can verify the recipient identity and encrypt to the recipient messaging key.
- Preserve existing v3 mobile API behavior until upgraded iOS and Android clients are shipped and old clients are forced off.

## Non-Goals

- Do not make Split messaging anonymous.
- Do not claim full metadata privacy.
- Do not hash or pepper `profilePicUrl` in this upgrade.
- Do not break existing `/messaging/v3/*`, wallet auth, profile, rewards, or session endpoints in place.
- Do not remove legacy raw fields until old client versions are no longer supported.

## Terminology

`Client hash` means a deterministic hash computed by the mobile client before sending a lookup value to the backend.

Example:

```text
clientHash = SHA256("split:messaging-ln:v1:" + normalizedLightningAddress)
```

`Server HMAC` means a deterministic keyed digest computed by the backend with a secret pepper.

Example:

```text
storedValue = HMAC_SHA256(MESSAGING_DATA_PEPPER, clientHash)
```

The server HMAC is the actual database privacy boundary. Client hashes are useful only in specific flows where the server does not need the raw input.

## Pepper Domains

Use separate peppers for separate privacy domains.

```text
USER_DATA_PEPPER
MESSAGING_DATA_PEPPER
```

The same raw value must produce unrelated stored values in different domains.

```text
HMAC(USER_DATA_PEPPER, "alice@example.com") != HMAC(MESSAGING_DATA_PEPPER, "alice@example.com")
```

Store HMAC version metadata so the system can rotate or migrate formats later.

```text
userHmacVersion = "split-user-hmac-sha256-v1"
messagingHmacVersion = "split-messaging-hmac-sha256-v1"
```

## Normalization Rules

All hashing and HMAC operations must use canonical normalized values.

- Wallet pubkeys: trim, remove optional `0x`, lowercase hex.
- Lightning addresses: trim and lowercase.
- Spark addresses: trim; casing rules must be confirmed before implementation.
- Messaging pubkeys: trim, remove optional `0x`, lowercase hex.
- Client hashes: lowercase hex string output unless a binary transport is explicitly defined.

Normalization bugs will create duplicate accounts, failed lookups, or broken uniqueness checks, so normalization must be shared and tested.

## Data Classification

| Data | Client Hash | Server HMAC | Store Raw | Notes |
| --- | --- | --- | --- | --- |
| Wallet pubkey for auth | No | Yes, user pepper | No long-term | Server needs raw pubkey transiently to verify wallet signature. |
| Wallet pubkey for messaging metadata | Maybe | Yes, messaging pepper | Avoid | Messaging domain should not reuse the core user HMAC. |
| Spark address | No for phase one | Yes, user pepper | No long-term | Only HMAC if used for lookup or dedupe. |
| Core Lightning address | Maybe | Yes, user pepper | No long-term | Used for profile/account uniqueness. |
| Recipient Lightning address lookup | Yes | Yes, messaging pepper | No | Good target for client hash plus server HMAC. |
| Own Lightning address registration | Maybe raw | Yes, user and/or messaging pepper | Avoid long-term | Raw may be needed for signature binding during registration. |
| Messaging pubkey | No | Maybe, messaging pepper | Yes in binding | Recipient clients need raw messaging pubkey for encryption. |
| Messaging identity signature | No | No | Yes | Needed for client verification and audit/history. |
| Messaging identity signed-at/version | No | No | Yes | Needed to validate and order bindings. |
| Directory leaf hash/root/proof material | No | No | Yes | Already a digest/proof structure. |
| Direct message ciphertext | No | No | Yes | Message body is already client-encrypted. |
| Direct message nonce | No | No | Yes | Required for recipient decryption. |
| Sender ephemeral pubkey | No | No | Yes | Required for recipient decryption. |
| Push device token | No | Lookup HMAC only | Encrypt | Push services need the exact token. Hashing alone breaks delivery. |
| Profile picture URL | No | No | Yes for now | Known privacy issue, intentionally deferred. |
| Core `User._id` in messaging records | No | Avoid long-term | Legacy only | Replace with messaging-domain identifiers in v4. |

## Client Hashing Policy

Client hashing should be targeted, not universal.

Use client hashing when:

- the value is a human-readable lookup identifier, such as a recipient Lightning address
- the server does not need the raw value to verify a signature or perform an external call
- the backend can complete the operation by applying a server HMAC over the client hash

Do not use client hashing when:

- the server must verify a wallet signature using the raw wallet pubkey
- the server must later send the exact value to an external service, such as APNs or FCM
- the value is already encrypted payload material
- the recipient client needs the exact public key or signature to verify and decrypt

Recommended recipient lookup shape:

```text
normalizedLightningAddress = lowercase(trim(input))
clientHash = SHA256("split:messaging-ln:v1:" + normalizedLightningAddress)
serverLookupKey = HMAC_SHA256(MESSAGING_DATA_PEPPER, clientHash)
```

## Server HMAC Policy

Server HMAC should be used for all stored identifiers that need deterministic equality checks.

Use HMACs for:

- account lookup by wallet pubkey
- account lookup or uniqueness checks by Lightning address
- Spark address lookup or dedupe if needed
- messaging recipient lookup
- messaging account ownership lookup
- messaging block targets
- messaging participant routing metadata where exact raw identity is not needed

Do not use HMACs for:

- values that must be returned exactly to clients for cryptographic verification
- message ciphertext, nonces, and ephemeral keys
- push tokens, which should be encrypted instead
- profile picture URLs in this phase

## Wallet Auth

Wallet auth continues to receive the raw wallet pubkey.

Flow:

1. Client requests `/auth/nonce`.
2. Client signs the canonical auth message.
3. Client submits raw wallet pubkey, nonce, signature, and required auth fields.
4. Server verifies the signature using the raw pubkey.
5. Server computes `walletPubkeyUserHmac`.
6. Server looks up or creates the user by `walletPubkeyUserHmac`.
7. Server does not persist the raw wallet pubkey in new privacy-first records.

Legacy `/auth/wallet-login` must keep working until old clients are unsupported.

## Messaging Identity Model

Move current messaging identity data out of the core `User` document.

Current `User` fields to migrate away from:

```text
messagingPubkeyV2
messagingIdentityV2Signature
messagingIdentityV2SignatureVersion
messagingIdentityV2SignedAt
messagingIdentityV2UpdatedAt
```

Proposed v4 collections:

```text
MessagingAccount
- _id
- lightningAddressMessagingHmac
- walletPubkeyMessagingHmac
- activeBindingId
- hmacVersion
- createdAt
- updatedAt

MessagingBinding
- _id
- messagingAccountId
- messagingPubkey
- messagingPubkeyMessagingHmac optional
- messagingIdentitySignature
- messagingIdentitySignatureVersion
- messagingIdentitySignedAt
- active
- createdAt
- updatedAt

MessagingDeviceRegistrationV4
- _id
- messagingAccountId
- messagingPubkeyHmac optional
- platform
- environment
- deviceTokenCiphertext
- deviceTokenIv
- deviceTokenAuthTag
- deviceTokenKeyVersion
- deviceTokenLookupHmac
- registrationSignature
- registrationSignatureVersion
- registrationSignedAt
- appVersion
- bundleId
- lastSeenAt
- createdAt
- updatedAt
```

The domain split should remain. The initial v4 directory response is backend-owned and does not yet expose Merkle proof material.

## Core User To Messaging Bridge

Messaging records should not store core `User._id` long-term.

Current direction: do not create a durable `User._id` to `messagingAccountId` bridge unless implementation proves it is necessary.

v4 authenticated messaging requests should prefer proving ownership by wallet signature and resolving the messaging account through messaging-domain HMACs. The core session can authorize that the caller is logged in, but v4 message, block, binding log, and device registration records should not store core `User._id`.

## Backend-Owned Directory

The directory should live on the backend.

Clients should not maintain the directory as the source of truth. Clients should request the recipient binding from the backend when they need to message someone.

Recipient lookup v4:

1. Sender enters recipient Lightning address.
2. Client normalizes and hashes the recipient Lightning address.
3. Server HMACs the client hash with `MESSAGING_DATA_PEPPER`.
4. Server finds the active messaging account and binding.
5. Server returns the recipient binding.
6. Client verifies the binding signature using the same recipient Lightning address client hash it submitted.
7. Client encrypts to the returned messaging pubkey.

The returned binding must include the raw wallet pubkey so the client can verify the wallet signature. The binding should not need to include the raw Lightning address; clients can verify against the Lightning address client hash they computed before lookup.

Current v4 identity signature message:

```text
SplitRewards Messaging Identity Authorization
version=4
domain=splitrewards.messaging
hashScheme=split-ln-address-sha256-v1
walletPubkey=<raw wallet pubkey>
lightningAddressHash=<client hash of normalized Lightning address>
messagingPubkey=<raw messaging pubkey>
signedAt=<unix seconds>
```

The backend verifies the signature with the raw wallet pubkey, then stores messaging-domain HMACs for lookup/indexed identity fields.

v4 messaging send, inbox, device registration, and block actions require an active v4 messaging identity.

## API Versioning

Do not change v3 request or response contracts in place.

Add v4 endpoints for privacy-upgraded messaging behavior.

Implemented v4 surfaces:

```text
POST /messaging/v4/identity
GET  /messaging/v4/identity
POST /messaging/v4/directory/lookup
POST /messaging/v4/send
GET  /messaging/v4/inbox
POST /messaging/v4/ack
POST /messaging/v4/device-registrations
GET  /messaging/v4/outgoing-statuses
POST /messaging/v4/rekey-required
POST /messaging/v4/decrypt-failed
POST /messaging/v4/blocks
GET  /messaging/v4/blocks
DELETE /messaging/v4/blocks/:target
```

Core account privacy changes can be additive on existing auth/profile routes only if old response shapes remain compatible.

## Additive Migration

This migration must be additive.

Phase one:

1. Add HMAC helpers and version constants.
2. Add new user HMAC fields.
3. Add messaging-domain account/binding fields or collections.
4. Add env vars for peppers.
5. Add tests for normalization and HMAC determinism.

Phase two:

1. Backfill HMAC fields from existing raw values.
2. Backfill messaging accounts and active bindings from current `User` records.
3. Keep old v3 fields and routes intact.
4. Start dual-writing old and new fields where needed.

Phase three:

1. Ship v4 endpoints.
2. Move new clients to client-hash plus server-HMAC lookup flows.
3. Keep v3 active for old clients.
4. Let old relay data age out where possible instead of migrating every historical message.
5. Account deletion removes the user's v4 messaging account data and private v4 attachment objects when the account can be resolved from the authenticated wallet pubkey.

Phase four:

1. Stop writing raw identity fields in new v4 paths.
2. Force old app versions off v3 once rollout is complete.
3. Remove or scrub legacy raw identity data.
4. Remove legacy messaging fields from `User` after all consumers are gone.

## Legacy Data

Old relay data can age out.

Do not spend migration complexity on temporary pending/delivered messaging records unless product requirements demand old pending conversations remain visible across the v3 to v4 cutover.

Backfill durable identity data:

- users
- Lightning address uniqueness records
- messaging blocks if they must survive the v4 migration

Do not backfill v3 device registrations into v4. Upgraded clients register fresh through `/messaging/v4/device-registrations`.

## Environment Variables

Add env vars during implementation:

```text
USER_DATA_PEPPER
MESSAGING_DATA_PEPPER
PUSH_TOKEN_ENCRYPTION_KEY
PUSH_TOKEN_LOOKUP_PEPPER
USER_HMAC_VERSION=split-user-hmac-sha256-v1
MESSAGING_HMAC_VERSION=split-messaging-hmac-sha256-v1
PUSH_TOKEN_KEY_VERSION=split-push-token-aes-gcm-v1
```

Pepper rotation requires a separate design. Do not rotate by silently changing these values without a migration path.

## Decisions

Resolved or directional answers:

- Own Lightning address registration should send the client hash, not the raw Lightning address, for v4 messaging registration paths.
- v4 binding verification exposes the raw wallet pubkey to recipient clients because recipients need enough public key material to verify the wallet-signed binding.
- `profilePicUrl` stays as-is for this upgrade.
- v4 blocks are identified from the recipient Lightning address client hash, then enforced with the backend messaging-domain HMAC and resolved messaging account ID.
- v4 send, inbox, device registration, and block actions require an active v4 messaging identity.
- Do not create a durable core `User._id` to `messagingAccountId` bridge unless implementation proves it is necessary.

- Push device token encryption.
  Decision: v4 should encrypt push device tokens at rest. Store a separate HMAC lookup value for dedupe/update. Do not hash device tokens as the only stored value because APNs/FCM require the exact token for delivery.
- v3 device registration migration.
  Decision: do not migrate v3 device registrations into v4. Upgraded clients must create a fresh registration through `/messaging/v4/device-registrations`. v3 registrations remain only for v3 clients and can age out or be pruned after a matching v4 registration is created.

## Current Recommendation

Build client hashing and server HMAC together, but apply client hashing only where it helps.

Use this rule:

- client-hash lookup identifiers when the server does not need raw values
- server-HMAC every stored or indexed identifier
- encrypt values the server must later use exactly
- keep cryptographic public material raw when clients need it for verification or decryption
- leave `profilePicUrl` unchanged for this upgrade
