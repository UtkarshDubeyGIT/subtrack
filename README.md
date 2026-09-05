<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" alt="Subtrack" width="80" height="80" />
  <h1>Know what renews next.</h1>
  <p>A desktop home for your subscriptions, upcoming renewals, and recurring spending.<br />No bank connection. No inbox access. Just the details you choose to enter.</p>
  <p><a href="docs/user-guide.md">Getting started</a> · <a href="docs/privacy.md">Privacy</a> · <a href="https://github.com/UtkarshDubeyGIT/subtrack/issues">Report a problem</a></p>
</div>

## Get Subtrack

**Subtrack is being prepared for its first public desktop release.** Public installers are not yet verified for distribution. Follow the [Releases page](https://github.com/UtkarshDubeyGIT/subtrack/releases) for availability. Workflow artifacts marked **candidate** are for platform testing.

The first release targets **macOS (Apple silicon and Intel)** and **Windows (x64)**. Linux, mobile, and a browser app are not currently supported.

Once a verified release is available, download the installer for your computer, open Subtrack, and sign in through your browser. **You will not need Node.js, Rust, API keys, or a developer setup.**

## One place for the next charge

- **Capture a subscription in a few fields.** Add the service, amount, billing cycle, and next renewal date. Track one-time access too.
- **See what is coming.** Browse the renewal calendar and agenda, search services, and filter events.
- **Understand recurring spending.** View monthly and annual equivalents. Missing exchange rates are called out, and those amounts are excluded from totals.
- **Keep records up to date.** Edit dates, track trials, and mark subscriptions paused or canceled while retaining their history.
- **Make it feel local.** Set your time zone, home currency, and date and number format.

Subtrack records your decisions. **It does not cancel services, move money, or prevent a provider from charging you.** Manage billing directly with the provider.

## Start with three subscriptions

1. Sign in using your system browser and let it reopen Subtrack.
2. Confirm your time zone, regional format, and home currency.
3. Add the next three renewals you care about. Check their dates and prices against the provider.

Use **⌘ N** on Mac or **Ctrl N** on Windows to add another subscription. The in-app **Help & privacy** panel is available before and after sign-in.

## Your data, clearly explained

You enter subscriptions manually. Subtrack does not ask for access to your bank or inbox. Your subscription records and preferences **sync to an online account**; this is not a local-only app. Sign-in uses Clerk, and application data is stored through Supabase. Device session credentials use macOS Keychain or Windows Credential Manager.

An internet connection is required to sign in, load, and save records. Read [Privacy and data handling](docs/privacy.md) before entering personal information.

## Current limits

- Scheduled reminders require a configured server scheduler. The app checks due reminders while it is **open and online**. Notifications depend on device support and permission; email and closed-app delivery are unavailable.
- Automatic exchange-rate ingestion is not connected. Amounts without rates remain visible in their original currencies and are excluded from converted totals.
- Account export, account deletion, and in-app changes to sign-in security methods are unavailable. Individual subscriptions can be permanently deleted.
- Automatic updates are unavailable. Future updates will be distributed through the official Releases page.

## Help and feedback

Read the [user guide](docs/user-guide.md) for installation, reminders, and troubleshooting. [Report a problem](https://github.com/UtkarshDubeyGIT/subtrack/issues/new?template=bug-report.yml) with your operating system, app version, and steps to reproduce it. Public reports should never contain account details, subscription records, passwords, or tokens.

## Working on Subtrack

Developer instructions live in [Development](docs/development.md). Maintainers should use the [release runbook](docs/releasing.md), including its required native sign-in and signing evidence, before distributing installers.

Built with Tauri, React, and TypeScript. Source is available for inspection; **no redistribution license has been granted yet**.
