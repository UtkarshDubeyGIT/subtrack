# Privacy and data handling

This page describes the current implementation, not a promise of offline storage or end-to-end encryption.

## What Subtrack uses

You manually enter subscription details such as service names, prices, currencies, dates, status, and optional notes or payment labels. Subtrack stores those records, your calendar preferences, and renewal/reminder history through Supabase so they can be associated with your account. Clerk handles sign-in through your browser.

Subtrack does not connect to your bank, read your inbox, import transaction feeds, process payments, or cancel subscriptions for you. Do not enter full card numbers, bank credentials, passwords, or API keys in any field. A payment label should be a nickname, not a credential.

## On your device and online

Your records are cloud-synced, not local-only. The desktop needs an internet connection. Device session credentials use macOS Keychain or Windows Credential Manager; short-lived access tokens are held in memory. The database restricts account data using token-based ownership checks and row-level security. This is not a claim of end-to-end encryption: the service operator and infrastructure providers process data to operate the service.

## Removal and control

You can edit or permanently delete an individual subscription, including its retained renewal and reminder history. Deleting a record in Subtrack does not cancel its real-world service.

Sign-out clears the desktop session. Uninstalling is not an account deletion request and does not delete cloud records. Account-wide export, account deletion, and sign-in security-method changes are not available in this version.

## Reports

GitHub issues are public. Share only reproducible steps, app version, and operating-system information. Redact screenshots and never include account identifiers, subscription data, credentials, tokens, or full logs containing those values.

Before public distribution, the maintainer must establish distribution terms, an appropriate private support/contact route, and any operator-specific privacy and retention disclosures. See the [release runbook](releasing.md).
