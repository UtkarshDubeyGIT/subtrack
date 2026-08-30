# Auth broker deployment and validation

The desktop broker is a public Supabase Edge Function with private, service-role-only persistence.
It uses Clerk as an OAuth 2.0 identity provider, exchanges Clerk authorization codes only on the
server, then requests a standard short-lived Clerk session token from
`POST /sessions/{session_id}/tokens`. The desktop receives a one-minute, single-use broker code and
a rotating opaque refresh credential; only keyed HMAC hashes of those credentials are stored.

## Required Clerk configuration

1. Create a private Clerk OAuth application with the exact broker callback
   `https://<project>.supabase.co/functions/v1/auth-broker/v1/desktop/callback` and `openid` scope.
2. In Clerk's **Sessions → Customize session token** claims editor, add
   `{"role":"authenticated"}` and keep the standard session-token lifetime at five minutes or less.
   Do not create a Supabase JWT template and do not share a Supabase JWT secret with Clerk.
3. In the Supabase dashboard, add Clerk under **Authentication → Third-Party Auth** using the exact
   Clerk Frontend API domain. For local/self-hosted Supabase, configure `[auth.third_party.clerk]`
   with that domain instead. This must be completed before Clerk session tokens can reach the data
   plane as the `authenticated` Postgres role.
4. The broker accepts a session token only when its compact JWT uses an asymmetric algorithm and a
   key ID, its issuer/subject/session match the completed Clerk session, `role` is exactly
   `authenticated`, `nbf`/`iat` are current, and `exp` is future and no more than five minutes away.
   The OAuth access token used only to establish the Clerk session must contain `sub` and `sid` and
   expires within 24 hours of the broker clock.
5. Put the OAuth client secret and Clerk backend secret only in Supabase Edge Function secrets.
   Never prefix a desktop/Vite variable with either value.
6. Set `AUTH_BROKER_PUBLIC_URL` and `VITE_AUTH_BROKER_URL` to the exact HTTPS Edge Function base,
   including `/functions/v1/auth-broker`. Fixed safe path prefixes are preserved; credentials,
   query strings, fragments, encoded traversal, and ambiguous separators are rejected.
7. Keep the Tauri opener capability synchronized with the full authorize URL. Set
   `AUTH_BROKER_ALLOWED_ORIGINS` to the exact supported webview origins only:
   `tauri://localhost,http://tauri.localhost` (or the required subset). Session APIs answer valid
   preflights with `POST`, `OPTIONS`, and `content-type`; they never emit wildcard or credentialed
   CORS headers. Authorize and callback remain system-browser routes and do not opt into CORS.

Copy `supabase/functions/.env.example` only for local development. Use independently generated
high-entropy values for the HMAC and cleanup keys. Production secrets are set with `supabase secrets
set`, never committed.

## Database and cleanup

Apply migrations before deploying. Broker tables live in the non-exposed `private` schema, use RLS,
and revoke schema/table/RPC access from `anon` and `authenticated`. Only the service role can call the
narrow RPC surface. Schedule `POST <AUTH_BROKER_PUBLIC_URL>/internal/cleanup` with
`Authorization: Bearer <cleanup secret>`; invalid credentials deliberately return `404`.

## Evidence gate

Automated tests use a deterministic provider and store. Before marking the live gate passed, run the
pgTAP privacy test against a local/preview Supabase stack, then validate real email-code/social Clerk
authorization, standard token role/issuer/session/lifetime, refresh rotation/reuse revocation, Clerk
session revocation, and packaged macOS/Windows deep links. Do not capture emails, authorization
codes, tokens, provider responses, or request bodies in evidence.
