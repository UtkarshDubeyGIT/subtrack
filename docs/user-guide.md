# Using Subtrack

Subtrack is a manual subscription tracker for macOS and Windows. Verified public downloads are still pending. The steps below describe the intended installation and first-run flow once a release is available.

## Install

Get installers only from the [official Releases page](https://github.com/UtkarshDubeyGIT/subtrack/releases). Read the release notes for supported operating-system versions and known issues.

| Computer               | Download           | Install                                                |
| ---------------------- | ------------------ | ------------------------------------------------------ |
| Mac with Apple silicon | `aarch64` `.dmg`   | Open the disk image and drag Subtrack to Applications. |
| Intel Mac              | `x64` `.dmg`       | Open the disk image and drag Subtrack to Applications. |
| Windows x64            | `x64` setup `.exe` | Run the installer and follow its prompts.              |

On Mac, **Apple menu → About This Mac** identifies your chip. No developer tools or API keys are needed. If your operating system rejects a download or reports an unverified publisher, stop and report the release and filename; do not disable its security protections.

## First run

1. Open Subtrack with an internet connection.
2. Choose **Continue in system browser**. Complete sign-in and allow the browser to reopen Subtrack.
3. Confirm the detected time zone and regional format. Set your home currency, then choose **Save and continue**.
4. Choose **Add subscription**, enter its details, and save. Verify the next renewal date against the provider.

The regional format controls how dates and amounts look, such as `en-IN` for English (India). It does not translate the app. Home currency controls spend summaries; it does not change a subscription's original currency.

## Day to day

Start in **Subscriptions** for a spending overview and your saved services. Search by service, plan, or category, and sort by renewal date or name. Search filters the loaded list; it does not change spending totals. Select a subscription to edit it or review its history.

Switch to **Calendar** to inspect upcoming renewals and the daily agenda. **Show details** returns you to the selected subscription. Use the left and right arrow keys to switch workspace tabs. Open **Account settings** below the workspace to change preferences.

**⌘ N / Ctrl N** opens the add form. **Escape** closes an editor. Forms and calendar controls support keyboard navigation.

If you pause or cancel a service with its provider, update its status in Subtrack. A status change here only changes your record. **To stop charges, you must cancel with the provider.** Permanent deletion removes the subscription and its retained renewal/reminder history and cannot be undone.

## Spending and reminders

Monthly and annual totals are estimates normalized across active and trial subscriptions. They exclude paused, canceled, and one-time items. These are recurring equivalents, not a bank statement or a forecast of exact cash payments this month. Items with no available exchange rate are explicitly excluded from converted totals.

Reminder scheduling runs online. When configured by the operator, the desktop checks for due reminders every minute while the workspace is open. Supported device notifications may appear if permission is already granted; otherwise, check the in-app due list. Background or closed-app delivery and email delivery are unavailable. Keep another reminder for time-critical cancellations until the feature meets your needs.

## Troubleshooting

| Problem                                    | What to do                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser sign-in does not return to the app | Allow the browser to open Subtrack. If it stalls, use **Cancel and start over** in the app, then retry.                                                         |
| Session expired                            | Sign in again. Your synced records remain in your account.                                                                                                      |
| Settings or subscriptions do not load      | Check your connection and use the reload option. Confirm you signed in to the expected account.                                                                 |
| A save fails                               | Keep the editor open. Use **Retry change** when offered; do not repeatedly create duplicate entries.                                                            |
| A change conflicts with another update     | Use **Reload latest**, review the current record, and apply your edit again.                                                                                    |
| This installation needs an update          | Install the newest official build. If it continues, report the version and operating system.                                                                    |
| Reminders do not appear                    | Keep Subtrack open and online. Reminders also depend on the scheduling service; no reminder panel does not prove that no renewal is coming. Check the calendar. |
| A currency is missing from totals          | No exchange rate is available for it. The original amount is still shown.                                                                                       |

## Updates, privacy, and support

Updates are manual through the official Releases page. Sign out before removing Subtrack to clear its device session; uninstalling does not delete your online records. Account export and account deletion are not available in this version.

See [Privacy](privacy.md). For bugs, use [GitHub Issues](https://github.com/UtkarshDubeyGIT/subtrack/issues). Include the app version from the installer/release, your operating system, and reproducible steps. Redact screenshots before sharing. Never post private financial details or sign-in credentials.
