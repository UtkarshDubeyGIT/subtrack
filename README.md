# Subtrack

Security-first Tauri 2 + React foundation for the subscription tracker. Subscription features are
intentionally absent from this ticket.

## Local checks

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run security:deps:js
```

Rust/Tauri development additionally requires the stable Rust toolchain and platform prerequisites.
Install `cargo-audit` and `gitleaks` to run the two corresponding security scripts locally. See
[`docs/security/auth-risk-gate.md`](docs/security/auth-risk-gate.md) before configuring the
first-party development broker or using real Clerk test credentials.
