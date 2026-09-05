# Developing Subtrack

A privacy-first desktop subscription and renewal tracker. Subtrack tells you what renews next
without ever touching your bank account or your inbox — every subscription is entered manually, by
you.

Built as a Tauri 2 + React 19 desktop application over a Supabase Postgres data plane, with
authentication handled by Clerk through your system browser.

> For current user-visible capabilities and limits, see [the README](../README.md). For installer configuration and release gates, see [Releasing](releasing.md).

## Why manual entry

Most subscription trackers ask for read access to your bank feed or your email. Subtrack does not,
and cannot — there is no integration to compromise, no third-party credential to store, and no
transaction history leaving your machine. The tradeoff is that you enter subscriptions yourself.
That tradeoff is the product.

## Architecture

An npm workspaces monorepo.

```
apps/
  desktop/            Tauri 2 shell + React 19 renderer
    src/auth/         Clerk sign-in via system browser, deep-link ingress, session vault client
    src/account/      Preferences and onboarding
    src/subscriptions/Subscription management and renewal calendar
    src-tauri/        Rust shell; OS keychain commands, deep-link and single-instance plugins
packages/
  domain/             Pure logic: money, recurrence, renewal, lifecycle. No I/O.
  data/               Repositories over the Supabase Data API, Zod-validated on read and write
  schemas/            Shared Zod schemas
  design-tokens/      Design primitives
  test-fixtures/      Shared test data
supabase/
  migrations/         Schema, RLS policies, and hardening migrations
  functions/          Edge functions (currently the auth broker)
  tests/              pgTAP suites
  admin/              Environment-specific reviewed admin operations (not generic migrations)
docs/security/        Threat model and operational runbooks
scripts/              Hosted-configuration proof tooling
```

### Feature layering convention

Each desktop feature is split three ways, and new features should follow the same shape:

| File               | Responsibility                                                        |
| ------------------ | --------------------------------------------------------------------- |
| `*-runtime.ts`     | State machine and behaviour. Framework-free and unit-tested directly. |
| `*-composition.ts` | Wiring: builds a runtime from environment and transport dependencies. |
| `*Experience.tsx`  | React rendering only.                                                 |

### Security model

Three properties carry most of the weight. All three are enforced, not merely documented.

- **Ownership derives from the verified token.** Row-level security resolves the owner from the
  Clerk session token's `sub` claim via `private.current_clerk_subject()`. Policies never consult
  `user_metadata` or `auth.role()`.
- **The data plane fails closed.** Authorization additionally requires an exact issuer match
  against the single row in `private.clerk_identity_authority`. That row is deliberately absent
  from generic migrations — each environment must set it through a reviewed admin operation. With
  no row, every request is denied.
- **Secrets never reach the renderer.** Session material lives in the OS keychain behind three Rust
  commands. A service-role key must never appear in a `VITE_`-prefixed variable or the app bundle;
  `npm run security:config` guards this.

Some tables are intentionally read-only to clients. `reminder_deliveries` and `fx_rates` grant
`select` to `authenticated` and all writes to `service_role` only, so reminder computation and FX
ingestion must run server-side. This is by design; do not relax those policies to make a feature
easier.

Read before changing authentication or the data plane:

- [`docs/security/threat-model.md`](security/threat-model.md)
- [`docs/security/cloud-data-plane.md`](security/cloud-data-plane.md)
- [`docs/security/auth-broker.md`](security/auth-broker.md)
- [`docs/security/auth-risk-gate.md`](security/auth-risk-gate.md) — **read this before
  configuring a development broker or using real Clerk test credentials**
- [`docs/security/hosted-clerk-proof.md`](security/hosted-clerk-proof.md)

## Prerequisites

| Requirement                          | Needed for                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Node.js 22                           | All JavaScript tooling (CI pins 22; some dev dependencies reject 24.0–24.14) |
| Rust stable + platform prerequisites | Building or running the Tauri shell                                          |
| Docker                               | Local Supabase, `test:db`, and pgTAP suites                                  |
| Supabase CLI                         | Local stack and hosted configuration reconciliation                          |
| `cargo-audit`, `gitleaks`            | The two corresponding security scripts                                       |

Platform support is currently macOS and Windows — the keychain integration enables only the Apple
and Windows native backends.

## Setup

```sh
npm ci
cp .env.example .env
```

Then fill in `.env`:

| Variable                        | Meaning                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `VITE_AUTH_BROKER_URL`          | Exact HTTPS base URL of the auth broker. No secrets.       |
| `VITE_SUPABASE_URL`             | Supabase project URL                                       |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key. **Never** a service-role key.             |
| `CLERK_FRONTEND_API_DOMAIN`     | Clerk Frontend API domain, used by third-party auth config |

The Supabase host also appears in two static files that cannot read environment variables at
runtime, and both must match your environment or the packaged app will fail:

- `apps/desktop/src-tauri/tauri.conf.json` → `app.security.csp` → `connect-src`
- `apps/desktop/src-tauri/capabilities/main.json` → `opener:allow-open-url` allowlist

## Development

```sh
npm run supabase:start           # local Supabase (requires Docker)
cd apps/desktop && npm run tauri dev
```

Running the renderer alone with `npm run dev` inside `apps/desktop` works for UI iteration, but
authentication and the keychain require the Tauri shell.

## Checks

```sh
npm run check                    # format:check + lint + typecheck + test + security:config
npm test                         # unit and component tests
npm run typecheck
npm run build

npm run test:db                  # pgTAP via Supabase CLI
npm run test:pgtap:full          # full pgTAP suite
npm run test:migration-chain     # renewal migration chain

npm run security:deps:js         # npm audit --audit-level=high
npm run security:deps:rust       # cargo audit
npm run security:secrets         # gitleaks
npm run security:config          # asserts no secret or placeholder leaks into the bundle
```

`npm run check` must pass before every pull request. ESLint runs with `--max-warnings=0` and
Prettier formatting is enforced.

Database behaviour changes require pgTAP coverage wired into `tests/run-full-pgtap.sh`. Changes to
authentication or the data plane require the corresponding `docs/security/*.md` runbook to be
updated in the same change — those documents are operational, and letting them drift is itself a
security problem.

## Release status

See [Releasing](releasing.md) for the current evidence gates. Reminder computation and client acknowledgement exist in source; deployed scheduling and native behavior require verification. Email delivery, automated FX ingestion, account export/deletion, signed public installers, and auto-update remain unshipped.

## License

Not yet licensed for redistribution.
