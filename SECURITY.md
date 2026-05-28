# Security Policy

Split is a Bitcoin wallet and payments project. Please treat potential vulnerabilities with care and report them privately.

## Reporting A Vulnerability

Please do not open a public GitHub issue for security-sensitive reports.

Email security reports to:

```text
support@example.com
```

We aim to respond as soon as possible. If the report appears security-sensitive, we will keep the discussion private while we investigate and prepare a fix.

## What To Include

Helpful reports include:

- the affected repository, branch, commit, endpoint, or file
- clear reproduction steps
- the expected and actual behavior
- the security impact, including whether funds, wallet identity, user data, messages, attachments, rewards, or merchant data could be affected
- relevant logs, screenshots, request/response examples, or proof-of-concept details
- whether the issue appears to affect production, a public snapshot, or only local development

Please keep proof-of-concept material minimal and non-destructive.

## Scope

Security-sensitive areas in this backend include:

- wallet-authenticated sessions and signature verification
- auth cookies, session handling, and user identity endpoints
- rewards, merchant reporting, and payout-related data paths
- messaging directory, relay, inbox, acknowledgements, and delivery status logic
- messaging attachment upload, download, object storage, and retention behavior
- profile image upload and public asset handling
- push notification token handling and APNs/FCM integration
- server-side request handling, dependency vulnerabilities, and supply-chain concerns
- environment/configuration handling that could expose secrets or production infrastructure

## Out Of Scope

The following are generally out of scope unless they reveal a concrete security flaw in Split:

- spam, phishing, or social engineering reports
- denial-of-service reports based only on high-volume traffic without a specific vulnerability
- physical device compromise outside Split's control
- attacks requiring an already-compromised server, database, cloud account, or developer account
- automated scanner output without verification or impact analysis
- disclosure of public placeholder configuration in this repository

## Testing Guidelines

Do not:

- move, spend, or attempt to move real funds
- access, modify, delete, or exfiltrate data that does not belong to you
- attempt to obtain wallet seeds, private keys, APNs/FCM keys, database credentials, object storage credentials, or production secrets
- run destructive tests against production infrastructure
- publicly disclose the issue before we have had a chance to investigate and remediate

If you believe production testing is necessary to demonstrate impact, contact us first.

## Supported Versions And Public Snapshots

This public repository exists for transparency and source availability. Active development and security fixes may land privately before public snapshots are refreshed.

Security fixes are prioritized for the deployed backend and released mobile clients first. Public repositories may be updated after the production fix and release path are complete.

## Bug Bounty

Split does not currently offer a paid bug bounty program.

We appreciate good-faith, responsible security reports.
