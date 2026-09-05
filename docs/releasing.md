# Releasing Subtrack

Version 0.1.0 is a release candidate target, not a declaration that distribution is approved. Candidate artifacts are for platform testing. The repository currently lacks native authentication evidence, production signing evidence, and distribution terms.

## Build candidates

Use Node.js 22, `npm ci`, Rust stable, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). For local builds, put public deployment values in `.env.production.local` at the repository root:

- `VITE_AUTH_BROKER_URL`: deployed broker's exact HTTPS base URL.
- `VITE_SUPABASE_URL`: deployed data API origin.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: an `sb_publishable_` key, never a secret or service-role key.

Run `npm run check`, then `npm run release:prepare`. Preparation uses Vite's production environment precedence and generates the ignored `apps/desktop/src-tauri/tauri.release.conf.json`. It aligns both service origins in the CSP and grants the browser opener only the broker's authorize route. It does not modify the source templates or include the key in the override. Invalid/missing configuration deletes the stale override and fails.

On macOS:

```sh
cd apps/desktop
npm run tauri -- build --config src-tauri/tauri.release.conf.json --bundles dmg
```

On Windows:

```sh
cd apps/desktop
npm run tauri -- build --config src-tauri/tauri.release.conf.json --bundles nsis
```

Re-run preparation after changing environment values. Users receive a configured installer and never edit environment files. For a configured development shell, use the same override with `tauri dev`, ensuring the development renderer values match the production values used to generate it.

For CI, set the same three **repository variables** and manually run **Desktop installer candidates** on the intended branch. It runs the JavaScript quality gate and dependency audit, builds Apple silicon, Intel Mac, and Windows x64 installers, and uploads architecture-specific artifacts with SHA-256 checksums for 14 days. It has read-only repository permissions and cannot publish a release. macOS Intel is cross-compiled; it must still be tested on Intel hardware. The generated override uses Tauri's [inline capabilities](https://v2.tauri.app/reference/config/#capabilities).

## Public-release gates

Do not mark an item passed without its evidence. Record artifact hashes, the source commit, tested OS versions, dates, and redacted evidence links in `docs/release-evidence.json`. Bump its version when changing the root/desktop manifests, package lock, Tauri config, and Rust manifest/lock for a new release. Existing evidence is not automatically transferable to a different build.

1. **Hosted services:** Apply the reviewed migrations and configure Clerk and the auth broker using `docs/security/*.md`. Complete the hosted identity proof against the environment embedded in the installer. Never weaken issuer checks or RLS to get a demo working.
2. **Packaged authentication:** Complete every macOS and Windows cell in `docs/security/auth-risk-gate.md`, including restart, revocation, deep-link replay, and vault inspection. Only then may its status change to PASS.
3. **Actual reminders:** Verify scheduling is deployed and a real test renewal is materialized and shown. Test device permission denial and an offline restart. The SQL engine and client panel alone do not prove a scheduler is operating. Email and closed-app delivery remain unavailable and must not be advertised.
4. **Native installers:** On each supported architecture, test clean installation, first sign-in, preference save, create/edit/restart persistence, cancel/delete semantics, calendar keyboard and drag behavior, sign-out, upgrade, and uninstall. Confirm embedded endpoints contain no placeholders. Record supported OS versions rather than guessing them.
5. **Signing:** Produce and test Apple Developer ID-signed, notarized macOS builds and Authenticode-signed Windows installers. Follow Tauri's [macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [Windows signing](https://v2.tauri.app/distribute/sign/windows/) instructions. Credentials belong in protected CI secrets, never source or public `VITE_` values. This candidate workflow does not provision signing identities. Verify signatures on the exact artifacts to distribute, then regenerate checksums after signing.
6. **Distribution and support:** The owner must choose distribution terms and establish a private support route and accurate operator privacy/retention disclosures. No license is inferred from the repository being public. Confirm the release notes disclose unavailable account export/deletion, automatic FX ingestion, email/background reminders, and auto-update.
7. **Full checks:** Confirm Security workflow gates pass, including database suites, Rust audit, and secret scanning. Run `npm run release:check` with the public environment configured; it fails until the recorded gates pass. This checks configuration and evidence presence, not the truth of manually recorded evidence.

## Publish the reviewed artifacts

Once all gates pass, prepare a **draft** GitHub release for the reviewed commit and version, attach the verified signed installers and their final checksums, and use `release-notes.md` as the starting point for user-facing notes. Check every download and architecture label. The owner reviews and publishes the draft. Do not publish unsigned workflow candidates as production downloads.

Automatic updates are not implemented. Keep the app identifier stable (`app.subtrack.desktop`) so subsequent installers update the same application. Avoid claiming a download is available in the README until a verified release is actually published.
