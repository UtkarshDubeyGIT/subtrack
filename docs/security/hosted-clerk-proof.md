# Hosted Clerk signed-token proof

This one-shot development command proves that `subtrack-dev` accepts a current standard Clerk
session token for `https://steady-ladybug-22.clerk.accounts.dev`, rejects an enabled signed
non-Clerk token, and removes its disposable subscription fixture:

```sh
npm run prove:hosted-clerk:subtrack-dev
```

Run it from the repository root while the pinned Supabase CLI is authenticated. Interact only with
the Clerk sign-in UI opened in the system browser. The terminal command accepts no project, issuer,
key, or token arguments and refuses unexpected arguments.

## Clean development-browser run

Close every old loopback or Clerk sign-in tab before a retry, end any earlier test session associated
with an interrupted or exposed run, and start a fresh command. Never reuse or copy a development
handshake from a screenshot, browser address, developer tools, or previous run.

In a Clerk development instance, Clerk may return the browser to the loopback root with one temporary
development-browser handshake query. The receiver accepts only that exact root shape, only once, with
one nonempty compact value bounded to 8 KiB. It evaluates the raw request target without decoding or
retaining the value and never reflects it in HTML, errors, output, or evidence. `Clerk.load()` consumes
the handshake. For a successful load, rejected load, or cancellation while loading, the same
idempotent `history.replaceState` scrub removes the query before any continuation, loopback report, or
visible outcome. Forced Clerk redirects always use the bare loopback root. If the browser refuses the
history replacement, the page shows one fixed local error, disables cancellation, clears the sign-in
surface, and performs no authentication or loopback handoff work.

After the live proof succeeds or fails, end the Clerk test session and re-enable bot protection
immediately if it was temporarily disabled. Then close the proof tab. Only the redacted terminal
result is reviewable evidence.

The command binds an ephemeral server only to `127.0.0.1`, opens its no-store page, and waits up to
five minutes. The page loads exact Frontend API assets `@clerk/clerk-js@6.26.0` and
`@clerk/ui@1.28.0`, mounts Clerk's `SignIn`, and calls `session.getToken({ skipCache: true })` without
a JWT template. A 256-bit per-run state, exact Host and Origin, bounded JSON body, single use, and
immediate shutdown protect the browser-to-terminal handoff. Selecting **Cancel proof** or closing the
page and allowing the timeout fails closed.

The page uses one phase arbiter for loading, cancellation, token acquisition, delivery, failure, and
success. Cancellation wins while token acquisition is pending: the page reports cancellation once
and discards any token that arrives later. Once token delivery starts, cancellation is disabled and
inert, so an accepted handoff cannot also be reported or displayed as cancelled. Each asynchronous
continuation verifies that it still owns the active phase before performing further work.

The authenticated repository-pinned Supabase CLI discovers exactly one publishable key and the
enabled legacy anon JWT in process memory. It is never invoked with a reveal option, and code does
not dereference secret or service-role key values. The Clerk token, public keys, JWT claims, request
headers, and response bodies remain in browser/process memory and are never logged or written.

The positive path creates, reads, updates, and deletes a random `sub_proof_*` subscription through
`/rest/v1`. The negative path sends the legacy signed anon JWT as the bearer with the publishable API
key and accepts only HTTP 401 or 403 as denial. Any 2xx is a trust-boundary failure; missing routes,
other statuses, and transport errors are configuration/network failures. Cleanup runs after every
create attempt and cleanup failure makes the command fail.

On success, stdout and `.proof/hosted-clerk-proof-result.json` contain only:

- the timestamp, exact public issuer, project name/ref, and generic fixture ID;
- positive create/read/update/delete status codes;
- the negative denial status/classification;
- cleanup status.

The `.proof/` directory is ignored by Git and the atomic result file is created through a private
temporary file. Copy only this redacted result into the hosted-gate artifact after reviewing it.
Never copy browser developer-tools data, CLI key output, JWTs, or response bodies.

On failure, nothing is written to `.proof/`. Stderr contains only the fixed public target and one
closed diagnostic object:

```json
{
  "outcome": "failed",
  "issuer": "https://steady-ladybug-22.clerk.accounts.dev",
  "project": "subtrack-dev",
  "projectRef": "qjsyhvclllikkopjfqtc",
  "failure": { "code": "positive_update", "status": 500 }
}
```

The allowlisted codes are `public_key_discovery`, `browser_launch`, `user_cancelled`, `browser_ui`,
`token_handoff`, `token_contract`, `positive_create`, `positive_read`, `positive_update`,
`negative_boundary`, `negative_configuration`, `cleanup`, and `transport_or_configuration`.
`browser_ui` means ClerkJS/UI bootstrap failed; token acquisition, loopback delivery, and timeout use
`token_handoff`. Token structure and standard-claim rejection are deliberately aggregated as
`token_contract`.

Only the positive REST, negative-classification, and cleanup codes carry a native HTTP status.
Failures without a trusted response use `transport_or_configuration` and carry no status. The
serializer never inspects an exception's properties and never emits exception text, stacks, claims,
values, response bodies, headers, request URLs, keys, tokens, identity, or CLI output. The browser
shows only matching safe stage guidance and sends only `browser_ui` or `token_handoff` to the
loopback receiver.

This follows Clerk's current vanilla JavaScript pattern—load ClerkJS/UI, mount `SignIn`, and call the
active session's standard `getToken()`—and Supabase's current first-class Clerk third-party auth
boundary. Supabase requires asymmetric JWTs with a `kid`; its legacy JWT-template integration is
deprecated.

- [Clerk JavaScript quickstart](https://clerk.com/docs/js-frontend/getting-started/quickstart)
- [Clerk development environments](https://clerk.com/docs/guides/development/managing-environments)
- [Clerk Session `getToken()`](https://clerk.com/docs/js-frontend/reference/objects/session#get-token)
- [Supabase Clerk third-party auth](https://supabase.com/docs/guides/auth/third-party/clerk)
- [Supabase third-party auth requirements](https://supabase.com/docs/guides/auth/third-party/overview)
- [Supabase API key types](https://supabase.com/docs/guides/getting-started/api-keys)
