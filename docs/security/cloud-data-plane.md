# Cloud data-plane security boundary

The public Supabase schema is an authenticated Data API surface. Clients send a current standard
Clerk session token and a Supabase publishable key. A service-role key is rejected by the shared
client and must never be placed in a Vite-prefixed variable or application bundle.

## Clerk third-party authentication

For local Supabase, set the non-secret `CLERK_FRONTEND_API_DOMAIN` value used by
`[auth.third_party.clerk]` in `supabase/config.toml`. For the hosted project, add Clerk under
**Authentication → Third-Party Auth** using the exact same Frontend API domain. Clerk session-token
issuance through the native Supabase integration must contain `{"role":"authenticated"}`. Ownership
always comes from the verified standard token's `sub` claim; Clerk subjects are stored as bounded
text. Policies never use `user_metadata` or `auth.role()`.

The database also requires an exact issuer match against the single row in
`private.clerk_identity_authority`. That row is intentionally absent from generic source migrations:
an environment-specific, reviewed admin migration must set the real `https://<frontend-api-domain>`
issuer before enabling the Data API for users. With no row, authorization fails closed. The local
configuration disables new Supabase Auth email, SMS, anonymous, and general signups. It does not
disable Supabase Auth itself or invalidate existing Supabase Auth users, who may still be able to
sign in. Deployment must mirror the hosted signup restrictions, verify that no legacy Supabase Auth
users or enabled providers remain, and prove a signed non-Clerk token is denied by the hosted Data
API. Clerk third-party auth remains enabled and does not use a JWT template or custom audience.

For `subtrack-dev` only, the reviewed idempotent operation is
`npm run admin:clerk-authority:subtrack-dev`. It locks the private authority table, upserts the exact
public issuer `https://steady-ladybug-22.clerk.accounts.dev`, and asserts that the result is exactly
one matching singleton before commit. This operation is deliberately outside `supabase/migrations`;
other environments must add their own reviewed operation rather than inherit the development issuer.

Hosted Auth settings are reconciled with
`CLERK_FRONTEND_API_DOMAIN=<public-domain> supabase config push --project-ref <ref>`. Review every
reported Auth change: the CLI reconciles all declared Auth settings, not only third-party auth. The
checked-in configuration therefore explicitly preserves the hosted site URL, redirect list, email
confirmation/rate/OTP settings, and TOTP settings alongside disabled general, email, SMS, and
anonymous signup. After reconciliation, inspect **Authentication → Third-Party Auth** and confirm one
Clerk entry with the exact domain; current Supabase CLI has no dedicated third-party-auth list command.

After both hosted control-plane entries are confirmed, run the one-shot
[`subtrack-dev` signed-token proof](./hosted-clerk-proof.md). It obtains a fresh standard Clerk token
through a loopback-only system-browser page, exercises owner CRUD plus signed non-Clerk denial, and
persists only redacted status evidence.

## Authorization model

- Client-writable rows omit `owner_user_id`; the database default derives it from the verified
  claims. Authenticated roles have no INSERT or UPDATE privilege on the owner column.
- Every exposed table has RLS forced on. User-owned tables have explicit SELECT, INSERT, UPDATE, and
  DELETE policies. UPDATE policies include both `USING` and `WITH CHECK`.
- A trigger makes ownership immutable and increments optimistic versions.
  `private.current_clerk_subject()` is the narrowly scoped `SECURITY DEFINER` helper that can read
  the private issuer authority while evaluating already verified claims; it has a fixed empty search
  path and only the authenticated/service roles can execute it.
- `private.enforce_owned_row()` remains `SECURITY INVOKER`; it has a fixed empty search path and is
  reachable only through its table triggers.
- Database transition guards mirror the domain state machines: lifecycle history cannot be rewritten
  in place, and renewal events can only move from expected to confirmed/skipped/corrected or from
  confirmed to a faithful correction. Authenticated INSERT is limited to the five expected-event
  columns and the database supplies `state = 'expected'`; authenticated DELETE is revoked and its RLS
  policy is explicit denial. Terminal renewal history is immutable.
- Reminder deliveries, FX rates, and audit events are server-written. Authenticated clients receive
  SELECT only; service-role credentials remain confined to server runtimes.
- Postgres Changes is intentionally disabled for owner data. Supabase documents that DELETE events
  are not filterable through RLS. A later feature may introduce private Broadcast channels with
  explicit Realtime Authorization rather than exposing deletion metadata cross-user.

## Repository boundary

`@subtrack/data` uses only the publishable key plus an in-memory Clerk access-token callback. It
validates every database response and every write input, omits ownership/server fields, preserves
integer minor-unit money, and normalizes all shape and post-schema semantic failures to one generic
error without database bodies, persisted values, or identity data.
The credential-bearing transport is internal, accepts only the seven known Data API tables, fixes
requests to the configured HTTPS `/rest/v1/` origin, and constructs trusted authorization headers
after all caller-controlled inputs. Token-provider failures and recognized server credentials fail
before any request. Every credentialed request uses `cache: "no-store"`.

Subscriptions carry an explicit metadata value for plan name, account email, payment label,
management URL, and notes. Management URLs cannot carry URL userinfo, while payment labels and notes
reject high-confidence full payment-card-number sequences. Both repository and PostgreSQL normalize
contiguous digits plus spaces, hyphens, dots, and Unicode whitespace, then require both Luhn and a
plausible Visa, Mastercard, American Express, Discover, JCB, Diners Club, or UnionPay IIN/length.
Masked last-four labels, IMEIs, and unrelated numeric identifiers remain valid. Corrected renewals
preserve both original minor units and original currency.
The PAN detector upgrade is reconciled forward: any pre-upgrade subscription field rejected by the
current helper is cleared individually to `NULL` without returning, copying, auditing, or logging its
prior value. Safe sibling metadata and the row remain intact. Both PAN CHECK constraints are then
rebuilt as `NOT VALID` and explicitly validated so their catalog state reflects a real scan of all
persisted subscriptions rather than the superseded helper definition.
Preference and reminder-override creation are separate from version-conditional updates;
subscription and override deletion also require an expected version. Renewal creation accepts only
expected events, and fixed confirm, skip, and correct operations retain expected-version conflicts.
Empty conditional mutations are conflicts, while absent reads remain `null`/empty results.

Every query uses an explicit stable projection instead of `select=*`. Each collection call first
captures a descending high-water tuple, then drains ascending immutable keysets bounded by that tuple
until an empty page. Cursor order is `created_at` plus the complete primary key; those fields cannot be
updated through authenticated grants. The requested `limit=1000` is only a page-size hint: completion
never depends on a short response or the deployed PostgREST cap, and non-monotonic/repeated pages fail
generically. Rows deleted before observation may disappear, while rows inserted after the high-water
tuple are deferred to the next call. Results are finally restored to their established presentation
order. FX `numeric(30,12)` values are projected as text and accepted only in the exact twelve-decimal
representation, avoiding JSON-number precision loss. Subscription and fixed renewal PATCH serializers
omit immutable identifier columns and use identifiers only as filters, matching authenticated column
grants. Migration preflight rejects legacy corrected renewals lacking an original currency with an
actionable error before stronger constraints are installed.

Behavioral coverage evidence is test-owned rather than production state. pgTAP derives effective
writable `(role, schema, relation, operation)` tuples for anon and authenticated across every
configured exposed schema, including direct, `PUBLIC`, and inherited-role privilege paths. Evidence
is inserted only by the same data-changing CTE whose result proves the corresponding behavior, then
compared exactly with the catalog-derived operation set. Renewal expected INSERT and denied owner
DELETE have dedicated behavioral assertions. The standalone security CI migration-chain job applies
the entire ordered forward chain to disposable PostgreSQL 17 and fails on drift.

### Pre-release corrected-renewal history repair

Migration `20260805040000_legacy_corrected_renewal_preflight.sql` is intentionally ordered before
the already-published `20260805044822` integrity migration. A development database that already
applied later migrations must first inspect an `--include-all` dry-run and then apply only this
reviewed retroactive migration. A database paused at `20260804220000` with corrected renewals stops
before constraint validation with an actionable error. The supported repair is to add the nullable
`original_currency_code` column, populate every affected row from authoritative billing history,
and rerun the migration chain. Never copy or infer the original currency from the current
`currency_code`; cross-currency corrections make that unsafe.

Local fixtures use only `user_fixture_*` and `sub_fixture_*` identifiers. `supabase/seed.sql` is for
local reset/start workflows and must never contain copied production rows.

The linked development project reports PostgreSQL 17.6 and is authoritative for the local major
setting. `supabase/config.toml` therefore declares major 17. The disposable renewal migration chain
uses a Supabase PostgreSQL 17 image and fails before startup when the config, image tag, or running
server major diverges.

## Reminder acknowledgement RPC

`public.acknowledge_reminder_delivery(text, text, text)` is the one reviewed addition to the
security-definer functions executable by `authenticated` (pinned by
`supabase/tests/cloud_data_plane_rls.sql`). It exists because `reminder_deliveries` denies all
direct client writes: the function derives ownership from the verified token via
`private.current_clerk_subject()` rather than from any argument, permits only the
pending/claimed to claimed/delivered/failed/canceled transitions, and requires an error code
exactly when a failure is being reported. The reminder engine's own computation runs entirely
server-side in `reminder_private` and is documented in
`supabase/migrations/20260830100000_reminder_engine.sql`; its invariants — including that a
client spoofing the engine's session flag gains nothing — are pinned by
`supabase/tests/reminder_engine.sql`.
