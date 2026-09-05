export function HelpPanel() {
  return (
    <details className="help-panel">
      <summary>Help &amp; privacy</summary>
      <div className="help-grid">
        <section>
          <h2>Start with your next renewal</h2>
          <ol>
            <li>Sign in using your browser and return to Subtrack.</li>
            <li>Confirm your time zone, regional format, and home currency.</li>
            <li>
              Add a service, its price, billing cycle, and next renewal date.
            </li>
          </ol>
          <p>
            Use ⌘ N on Mac or Ctrl N on Windows to add a subscription. Press
            Escape to close an editor.
          </p>
        </section>
        <section>
          <h2>You stay in control</h2>
          <p>
            Subtrack keeps the records you enter in your online account. It does
            not connect to your bank, read your inbox, or cancel services for
            you.
          </p>
          <p>
            Changing a status or deleting a record here does not stop charges.
            Cancel with the service provider first.
          </p>
          <p>
            Never enter passwords, full card numbers, or other credentials in
            notes.
          </p>
        </section>
        <section>
          <h2>What to expect</h2>
          <p>
            An internet connection is required to sign in, load, and save your
            records. Keep Subtrack open and online for scheduled reminders.
            Email and closed-app reminders are not available.
          </p>
          <p>
            Totals exclude currencies without an available exchange rate.
            Account export and account deletion are not available in this
            version.
          </p>
        </section>
        <section>
          <h2>Need a hand?</h2>
          <p>
            If sign-in stalls, cancel and try again. Allow your browser to
            reopen Subtrack. If a save fails, keep the app open and use Retry
            change when offered.
          </p>
          <p>
            For downloads and support, open{" "}
            <strong>github.com/UtkarshDubeyGIT/subtrack</strong> in your
            browser. Include your app version, operating system, and steps to
            reproduce the problem. Leave account details and subscription data
            out of public reports.
          </p>
        </section>
      </div>
    </details>
  );
}
