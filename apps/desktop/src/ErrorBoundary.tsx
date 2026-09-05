import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  Readonly<{ children: ReactNode }>,
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main>
        <p className="eyebrow">SUBTRACK</p>
        <h1>Let’s try that again.</h1>
        <p role="alert">
          Subtrack couldn’t display this screen. Restart the view to continue.
          Unsaved edits may need to be entered again.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Restart view
        </button>
        <p className="field-help">
          If this keeps happening, report the steps at
          github.com/UtkarshDubeyGIT/subtrack/issues. Do not include private
          account or subscription details.
        </p>
      </main>
    );
  }
}
