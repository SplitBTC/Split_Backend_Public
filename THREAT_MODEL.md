# Threat Model

Split is a self-custodial Bitcoin wallet and payments project. This document describes the security boundaries we intend to maintain, the threats we actively consider, and the areas that are outside our current guarantees.

This document applies to the current public source snapshot. Public repositories may lag private development while fixes and releases are prepared, but the security model described here is intended to apply to released Split clients and backend services.

## Security Goals

Split is designed to:

- keep wallet seed phrases and private wallet credentials local to the user's device whenever possible
- use wallet-controlled keys as account identity
- prevent backend operators from spending user funds
- protect authenticated backend APIs from unauthorized access
- reduce accidental exposure of user messages, attachments, profile data, rewards data, and merchant data
- avoid silent breaking changes to mobile API contracts
- make sensitive security limitations explicit

## Non-Goals

Split does not currently claim to protect against:

- compromise of a user's device, operating system, biometric unlock, screen, keyboard, or clipboard
- users sharing seed phrases, screenshots, backups, QR codes, NWC secrets, macaroons, runes, or API passwords
- malicious or compromised third-party wallet/node software
- malicious relay, push-notification, cloud, app-store, or operating-system infrastructure
- chain analysis, network-level metadata analysis, or global traffic correlation
- recovery of lost seed phrases or self-custodial wallet credentials
- guaranteed anonymity

## Custody Model

Split's mobile wallet is intended to be self-custodial.

User wallet seed phrases and wallet credentials should remain on the user's device or in user-controlled wallet/node software. The Split backend should not need a user's seed phrase to authenticate a user, send from a user wallet, or manage that user's funds.

Users are responsible for backing up their wallet seed phrase and protecting any external wallet credentials they add to the app.

## Account Identity And Authentication

Split account identity is based on wallet-controlled public keys.

The backend issues short-lived nonces. Mobile clients sign a canonical authentication message with wallet-controlled keys. The backend verifies the signature and creates a short-lived authenticated session.

Security assumptions:

- the user's signing key remains secret
- the client signs the exact backend-provided message
- nonces are short-lived and single-use
- auth cookies are protected with appropriate HTTP-only and secure settings in production

## Backend Trust Boundary

The backend is trusted to:

- enforce API authorization
- store profile, messaging, rewards, merchant, and reporting data correctly
- relay encrypted messaging payloads without intentionally tampering with delivery state
- enforce retention and cleanup rules for relay messages and attachments
- protect production secrets and infrastructure credentials

The backend should not be able to spend from a user's self-custodial wallet without the user's wallet/device or user-provided external wallet authorization.

## Platform Wallet Boundary

Some Split platform operations may use a Split-controlled platform wallet, such as rewards or platform-managed payouts.

That wallet is operationally separate from user self-custody. Platform wallet seed material, API keys, storage, payout automation, and database access must be treated as production secrets. Compromise of the platform wallet could affect platform funds or rewards payouts, but should not give an attacker direct control of user self-custodial wallets.

## Local Secret Storage

Mobile clients may store sensitive material such as:

- wallet seed phrases
- messaging private keys
- NWC secrets
- LND macaroons
- Core Lightning runes
- Eclair API passwords
- wallet/node metadata needed to reconnect

These secrets should be stored using platform-provided secure storage such as iOS Keychain or Android encrypted storage.

Limitations:

- secure local storage does not protect against a fully compromised device
- secrets may be exposed if the user copies them to the clipboard, screenshots them, exports them, or stores them in cloud notes/messages
- rooted or jailbroken devices weaken the local security model

## Messaging Security

Split messaging is designed to limit plaintext exposure to the backend by using client-side cryptography for message content where supported.

Security goals:

- message content should not be stored by the backend in plaintext
- messaging identity bindings should be verifiable
- attachment relay should avoid permanent retention
- delivery and acknowledgement state should not reveal message contents

Limitations:

- metadata such as sender, recipient, timestamps, device registration state, attachment size, delivery status, and push-token association may be visible to backend infrastructure
- push notification services may learn device-token and delivery metadata
- this system should not be described as equivalent to Signal's full protocol unless and until it provides comparable forward secrecy, deniability, and ratcheting guarantees
- blocking, rekeying, retry, and attachment flows are security-sensitive and should be reviewed carefully

## External Wallet And Node Connections

Split may support connections to external wallets or nodes, including NWC, LND, Core Lightning, Eclair, Spark, or Lightning address flows.

Risks:

- imported credentials can grant spending or invoice permissions depending on the external wallet/node configuration
- a malicious node or relay may return misleading invoices, payment states, balances, or errors
- broad macaroons, runes, API passwords, or NWC permissions can expose more authority than the user intended
- Tor/onion, local-network, and remote-node connections may have different metadata and availability tradeoffs

Users should only connect wallets, nodes, and relays they trust.

## Dependencies And Supply Chain

Split depends on third-party packages, mobile SDKs, platform APIs, and build tooling.

Security expectations:

- dependency updates should be reviewed before release
- lockfile changes should be inspected
- known vulnerability audits should be run regularly
- package installation scripts and new transitive dependencies should be treated carefully
- production secrets must not be committed to public or private repositories

## API Compatibility

Backend routes used by released mobile clients are treated as compatibility contracts.

Security fixes should avoid breaking released clients when possible. If an API contract must change, Split should add a new version or new endpoint and keep the old path working until affected clients are updated or forced to upgrade.

## Backend-Specific Risks

Backend changes should be reviewed for:

- auth/session regressions
- wallet signature verification bypasses
- unauthorized access to profile, rewards, merchant, or messaging data
- upload handling vulnerabilities
- object storage access-control mistakes
- message relay retention or deletion failures
- push token handling mistakes
- dependency or environment variable exposure

## Responsible Disclosure

Security issues should be reported privately according to [SECURITY.md](./SECURITY.md).

Please do not publicly disclose vulnerabilities before we have had a chance to investigate and remediate them.
