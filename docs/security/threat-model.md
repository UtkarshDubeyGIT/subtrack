# Compact threat model

## Assets and boundaries

The desktop shell handles a Clerk identity session but no subscription content yet. The relevant
assets are the user's login session, email address, verification code, OAuth authorization code,
and the integrity of the desktop process. Clerk is the identity authority; the Tauri command bridge
and OS credential manager are separate trust boundaries.

| Threat                                          | Control                                                                                  | Executable evidence                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| Callback injection or code replay input         | Exact `subtrack://auth/callback`, two bounded parameters, broker must consume state once | `security.test.ts` malformed callback cases |
| Token or PII disclosure through errors          | Stable error codes/messages; raw provider errors never cross the UI boundary             | redaction test                              |
| Plaintext session persistence                   | Only an opaque handle is passed to Rust and saved with Keychain/Credential Manager       | controller tests and `src-tauri/src/lib.rs` |
| Compromised remote content invoking native APIs | Bundled main window only, no remote capability, explicit command allowlist               | `security-config.test.ts`                   |
| Shell/filesystem escalation                     | No shell or filesystem plugin/permission                                                 | `security-config.test.ts`                   |
| Malicious dependency or committed credential    | Exact lockfiles, high-severity npm audit, Rust audit, gitleaks CI                        | `security.yml`                              |

## Security invariants for this foundation

1. No Clerk secret key, service credential, bearer token, email, verification code, or raw request
   body is logged or returned in an application error.
2. JavaScript never writes session material to `localStorage`, `sessionStorage`, IndexedDB, or a
   plaintext Tauri store.
3. The only persistence command targets the OS credential manager and accepts a bounded session
   handle structure. A future broker credential may replace that structure only after this threat
   model and tests are updated.
4. Authentication callback input is rejected before provider or native code sees it unless the
   scheme, authority, path, query-key set, and parameter bounds match exactly.
5. Sign-out attempts remote revocation before local deletion. Expired or revoked restore attempts
   delete local state and end anonymous.
6. Remote documents cannot load in the privileged window or receive a Tauri capability.
7. A known high or critical JS/Rust dependency advisory and a detected committed secret fail CI.

## Deliberate limits

This is not a claim that cross-platform Clerk authentication has passed. The unvalidated risks and
the manual release-blocking matrix are recorded in `auth-risk-gate.md`. Production signing and
distribution are outside this ticket.
