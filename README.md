# Split Backend

Node/Express backend for the Split mobile apps and hosted Split pages.

This repo powers:

- wallet-authenticated sessions
- Lightning address and wallet identity endpoints
- Split messaging and messaging relay cleanup
- merchant, coupons, events, and rewards endpoints
- hosted public and merchant pages

## Why This Project Exists

The project-purpose writeup lives here:

- [PROJECT_PURPOSE.md](./PROJECT_PURPOSE.md)

That document explains the core thesis behind Split: Bitcoin should be usable as money, spending requires coordination, and communication is part of making a real Bitcoin economy work.

## Repo Status

This public repository exists for transparency and source availability. It is intentionally focused on the Split backend surface used by the mobile apps and current hosted Split pages.

Active development may occur privately before released code is synced here. Pull requests may not be reviewed or merged.

The code is real production code, but running it locally still requires your own infrastructure and secrets. Do not expect this repo to boot against Split production services without configuration.

## Stack

- Node.js
- Express
- MongoDB / Mongoose
- Cloudflare R2 via S3-compatible APIs
- Google Maps integration for merchant/event location flows
- APNs / FCM for push notifications

## Project Layout

- [app.js](./app.js): Express app wiring
- [server.js](./server.js): runtime bootstrap, Mongo connection, cleanup startup
- [routes](./routes): backend API routes used by the mobile apps and hosted pages
- [models](./models): Mongo models
- [messaging](./messaging): push delivery, directory logic, relay cleanup
- [integrations](./integrations): infrastructure clients such as R2
- [merchant](./merchant): merchant wallet-auth helpers
- [services](./services): integrations and background job helpers
- [views](./views): hosted page templates
- [tests](./tests): backend unit and smoke tests

## Requirements

- Node.js 22 recommended
- npm
- a MongoDB database
- an R2/S3-compatible bucket if you want uploads to work
- Google Maps credentials if you want merchant/event location flows
- APNs / FCM credentials if you want push notifications

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy the example env file and fill in your own values:

```bash
cp .env.example .env
```

3. Start the backend:

```bash
npm run dev
```

By default the server starts on port `3000`.

## Scripts

- `npm start`: run the production server bootstrap
- `npm run dev`: run the server with `nodemon`
- `npm test`: run the backend test suite

## Environment Variables

See [.env.example](./.env.example) for the supported configuration surface.

Important note:

- this repo intentionally does **not** include production secrets
- the real `.env` file is gitignored
- APNs / FCM / Mongo / R2 / Google Maps values must come from your own infrastructure

## Testing

Run the backend tests with:

```bash
npm test
```

The current suite covers:

- messaging directory hashing / proof logic
- messaging and wallet route smoke coverage
- relay cleanup behavior

GitHub Actions is configured to run the backend suite on push and pull request.

## Messaging Notes

The messaging trust/privacy writeup lives here:

- [MESSAGING_PRIVACY_AND_TRUST.md](./MESSAGING_PRIVACY_AND_TRUST.md)

That document is deliberately technical and deliberately conservative in its claims.

## Running Your Own Instance

If you want to run your own deployment instead of the hosted Split backend, you should expect to configure at least:

- MongoDB
- R2 / object storage
- APNs / FCM
- Google Maps, if using merchant/event location flows
- wallet-auth domain values

Also note:

- CORS in [app.js](./app.js) is driven by `CORS_ORIGIN`
- set that value to match your own frontend or web client deployment

## Open Source Hygiene

Before publishing or accepting outside contributions, this repo should be treated as public-facing:

- do not commit `.env`
- do not commit push keys or service secrets
- do not commit bucket credentials
- do not commit internal-only support docs or incident notes

## License

This repository is licensed under the Apache License 2.0.

See [LICENSE](./LICENSE).
