# Split Backend AGENTS.md

## Optional Internal Context

- Internal Split agents with access to the full project folder should also review `PROJECT_MAP_INTERNAL.md` at the project root for cross-repo context.
- That file is supplemental only. This repo's `AGENTS.md` must remain sufficient on its own.

## Repo Role

This repo is the center of the Split project.

- It is the backend server for the live iOS app in `Split Rewards`.
- It also supports the Android app in `Split Android`.
- It owns API compatibility, wallet-authenticated sessions, messaging, rewards, merchant reporting, and hosted Split pages.

## System Relationships

- `Split` is the backend source of truth.
- `Split Rewards` is the primary live client and the first place new product work lands.
- `Split Android` should be kept behaviorally aligned with iOS, but can use Android-native implementation details.
- Backend changes must be evaluated against both mobile clients, not just the repo currently being edited.

## Non-Negotiable Rules

- Never make a breaking mobile API change in place if released clients depend on the old behavior.
- When an API contract must change, create a new version or a new endpoint and keep the old one working until the new client versions are shipped and users are forced to update.
- Only remove old endpoints after the replacement app versions are live and the old client path is no longer needed.
- Treat auth, messaging, rewards, and profile routes as shared mobile contracts.
- Do not assume `routes/iOSEndPoints.js` is iOS-only in practice. The filename is legacy; the backend serves both mobile apps.

## Deployment And Release Flow

User-provided project rule:

- Pushing the backend `dev` branch to GitHub deploys the Render dev server.
- Pushing or merging from `dev` to `main` deploys the Render production server.

When changing backend behavior:

- consider dev/prod rollout impact
- preserve compatibility for already-released mobile builds
- avoid deleting legacy behavior until the mobile rollout plan is complete

## Current Repo Shape

- `app.js`: Express app wiring and route mounting
- `server.js`: HTTP bootstrap, Mongo connection, ngrok dev support, messaging relay cleanup startup
- `routes/`: route modules for core APIs and hosted pages
- `models/`: Mongo/Mongoose models
- `messaging/`: APNs/FCM silent push, directory logic, relay cleanup
- `auth/sessionHelper.js`: wallet auth nonce issuance and Breez signature verification
- `middlewares/userAuthMiddleware.js`: JWT-cookie session enforcement
- `integrations/r2.js`: object storage integration
- `rewards/`: reward calculation helpers
- `tests/`: backend test suite

## Key Mobile Contracts In This Repo

Important current backend surfaces include:

- version gate: `/rewards-version-check`
- wallet auth: `/auth/nonce`, `/auth/wallet-login`, `/session`
- Breez bootstrap: `/breez-api-key`
- profile media: `/Profile_Pic`, `/Upload_Profile_Pic`
- rewards: `/v1/RewardStats`
- merchant reporting: `/ReportMerchantPubkey`
- messaging: `/messaging/v4/*` for identity, lookup, send, inbox, ack, outgoing statuses, device registrations, blocks, and attachments
- Android update fallback: `/download`

## Working Rules For Future Changes

- Before changing any request or response shape, check both iOS and Android callers.
- Prefer additive migrations over hidden behavior swaps.
- Keep route versioning explicit and easy to reason about.
- If a new endpoint replaces an old one, document which clients should use which path.
- When touching shared contracts, update or add backend tests.
- If a change alters required env/config, update `.env.example` and relevant docs.
- Do not commit secrets, private support notes, production credentials, or local-only config.

## Testing And Verification

- Primary test command: `npm test`
- CI exists in `.github/workflows/backend-tests.yml`
- Node.js 22 is the expected runtime

When verifying backend work, prioritize:

- route smoke coverage
- auth/session compatibility
- mobile contract compatibility
- messaging regression risk

## Useful Entry Points

- `routes/iOSEndPoints.js`
- `routes/MessageEndPoints.js`
- `models/User.js`
- `auth/sessionHelper.js`
- `middlewares/userAuthMiddleware.js`

## Coordination Notes

- New features normally start in backend + iOS.
- Android usually follows after the iOS/backend version is stable and production ready.
- If a task would require deleting or breaking a live endpoint, stop and confirm the rollout plan first.
