# Contributing

Use Node.js 22.18 or later and install with `npm ci`. Keep changes focused, include meaningful regression coverage for behavior changes, and run `npm run test:quality` before submitting a pull request. Run `npm run verify:deployment` when changing worker bindings or deployment code.

Installation-specific names, endpoints and credentials belong in configuration. Never introduce a company domain fallback, employee seed data, real access token, or inferred identity merge. New D1 changes go in forward-only migrations under `schemas/`; do not rewrite an already released migration.

Follow the product naming and frontend standards in `docs/`. Shared UI primitives should not load business data. Preserve keyboard access, reduced-motion behavior, and the fixed palette pairs.

Do not include `.workspace`, credentials, generated plans, private logs, or customer data in pull requests. New repository CI builds and tests; it does not automatically deploy customer infrastructure.
