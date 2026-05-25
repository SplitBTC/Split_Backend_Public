# Split Backend Public AGENTS.md

## Optional Internal Context

- Internal Split agents with access to the full project folder may also review `PROJECT_MAP_INTERNAL.md` at the project root for cross-repo context.
- External or public-only review agents should ignore that file. This repo's `AGENTS.md` is the complete repo-local guidance.

## Repo Role

This is the public backend repository for Split.

- It exists for inspection, transparency, and community scrutiny.
- It is not the primary day-to-day development repo.
- It may intentionally lag behind the private `Split` backend repo.
- It should represent a public-safe snapshot of production-ready backend code when the user chooses to sync it.

## Intended Consumers

This file is for both implementation agents and review agents.

- Use it to understand what this repo is for before proposing changes or filing review findings.
- Do not treat this repo like the private source-of-truth backend repo unless explicitly instructed.

## System Relationships

- Private backend development happens in `Split`.
- This repo is a public publication target for backend code that is ready to be exposed.
- It should stay focused on the mobile app platform backend surface and the hosted Split pages that are part of the current backend snapshot, not unrelated private operations or separate applications.
- `Split Rewards Public` plays the same role for the iOS app.
- A public Android repo is planned later and should follow the same model.

## Non-Negotiable Rules

- This repo must always be open-source ready.
- Do not assume this repo should always mirror the private backend repo.
- Only sync code here when the user wants the public repo updated to a production-ready snapshot.
- Treat every push to `main` as an immediate public release.
- There is no dev branch safety net here. If a change is not ready for public exposure, it does not belong in this repo.
- This repo is not primarily for outside contributions. Its main purpose is transparency, inspection, and scrutiny.

## Review Posture

If you are reviewing this repo:

- Judge it as a public publication target, not as the main active development repo.
- Do not assume that a difference from the private backend repo is automatically a bug.
- Do flag anything that weakens public transparency, public safety, or the coherence of the published snapshot.
- Prioritize findings around secrets, internal-only material, misleading docs, broken public-safe config, or a snapshot that is obviously incomplete or inconsistent.
- Treat "this repo is behind private development" as expected unless the user says the public mirror should already include newer work.

## Public Release Rules

- Before publishing here, check for secrets, internal-only notes, private support docs, credentials, and staging-only material.
- Keep `.env`, production secrets, private keys, internal incident notes, and unpublished operational details out of this repo.
- Prefer public-safe defaults and examples over internal real-world config.
- Exclude private admin tooling, unpublished operational pages, internal support material, and separate applications unless the user explicitly wants them published here.
- Make sure README and public docs accurately describe the repo’s public role and limitations.

## Private-To-Public Sync Workflow

- Treat the private `Split` repo as the implementation source and this repo as a sanitized publication mirror.
- Do not do a blind file-for-file mirror from private to public.
- Sync newer production-ready code, tests, and architecture changes from private only after a publication sweep.
- Preserve the public repo's sanitization layer when it already exists.

When updating this public repo from private:

- keep public-facing README, AGENTS, and publication-oriented docs as the base versions
- update those docs only as needed to reflect new code or changed behavior
- keep public-safe config examples and placeholders instead of replacing them with internal real values
- remove or replace brand-specific defaults when they are not needed for public transparency
- exclude private operational notes, staging-only material, local-only config, unpublished support context, and unrelated website-only assets or templates

Default review stance during a sync:

- implementation changes should usually come from private
- sanitization, placeholder config, and public positioning should usually stay from public
- if the private version would weaken public safety or reveal internal setup, re-apply the public version or adapt the change before publishing

## Current Repo Shape

- `app.js`: Express app wiring
- `server.js`: runtime bootstrap
- `routes/`: backend API routes
- `models/`: Mongo models
- `messaging/`: push delivery and directory logic
- `auth/`: wallet-auth nonce and signature verification helpers
- `integrations/`: infrastructure integrations
- `rewards/`: reward logic helpers
- `merchant/`: merchant wallet-auth helpers
- `services/`: integrations and background job helpers
- `views/`: hosted page templates included in the public backend snapshot
- `tests/`: backend tests
- `.env.example`: public-safe configuration surface

## Working Rules For Future Changes

- If a backend change exists only privately and is not ready for public scrutiny, leave it out of this repo.
- If syncing from `Split`, do a publication sweep before pushing:
- remove or avoid secrets
- remove internal-only material
- verify docs and examples are public-safe
- verify the code reflects a coherent production-ready snapshot
- preserve the public repo's sanitized README/docs/config posture unless the user explicitly wants that changed
- Keep public-safe examples in `.env.example`.
- Keep tests and docs healthy enough that outside inspection is meaningful.
- Preserve the backend API versioning philosophy here too: do not present reckless breaking changes as if they were production-safe.
- If asked to review or update this repo, optimize for public clarity and publication readiness, not internal development speed.

## Testing And Verification

- Main verification command: `npm test`
- GitHub Actions exists for backend tests
- Prefer checks that support public confidence: tests passing, docs accurate, config sanitized

## Coordination Notes

- Active feature work usually starts in the private `Split` repo.
- This repo should be updated when the user decides the public backend snapshot should move forward.
- Never treat this repo like a staging branch.
- If unsure whether something is public-safe, stop and confirm before publishing.
