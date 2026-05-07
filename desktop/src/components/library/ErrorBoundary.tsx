import { Component, type ReactNode, type ErrorInfo } from "react";

/* Library-wide error boundary.
 *
 * Wraps each pane (Wiki / Notes / Memories / Skills) so a thrown
 * render error in one doesn't crash the whole Library tab. Shows a
 * compact "something went wrong here" card with a stack toggle
 * (collapsed by default — operators can expand for triage).
 *
 * Why a class component: React's error catching API only works with
 * componentDidCatch / getDerivedStateFromError, which require class
 * components today (the React team has discussed a hooks API but it
 * hasn't landed in any stable release as of this writing).
 */

type Props = {
  children: ReactNode;
  paneName: string;
};

type State = {
  err: Error | null;
};

export class LibraryPaneErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Log to console for dev; in production this should hop into a
    // proper telemetry sink. Decoupled from Sentry-style libraries
    // intentionally — wire that up at the app level.

    console.error(`[Library / ${this.props.paneName}]`, err, info.componentStack);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (this.state.err) {
      return (
        <div style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          minHeight: 0,
        }}>
          <div style={{
            maxWidth: 480,
            border: "1px solid color-mix(in oklab, var(--color-danger) 22%, var(--color-border))",
            background: "color-mix(in oklab, var(--color-danger) 5%, var(--color-bg-elevated))",
            borderRadius: "var(--radius-proto, 6px)",
            padding: "20px 22px",
            color: "var(--color-text-primary)",
          }}>
            <div style={{
              fontSize: 13,
              fontWeight: 600,
              color: "color-mix(in oklab, var(--color-danger) 75%, var(--color-text-primary))",
              marginBottom: 6,
            }}>
              {this.props.paneName} pane crashed.
            </div>
            <div style={{
              fontSize: 11.5,
              color: "var(--color-text-secondary)",
              lineHeight: 1.55,
              marginBottom: 12,
            }}>
              The rest of Library is fine — switching tabs or hitting
              <i> Reset </i> below will get you back. If this keeps
              happening please copy the stack trace below.
            </div>
            <details style={{ marginBottom: 14 }}>
              <summary style={{
                fontSize: 11,
                fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                color: "var(--color-text-muted)",
                cursor: "pointer",
              }}>
                {this.state.err.name}: {this.state.err.message.slice(0, 120)}
              </summary>
              <pre style={{
                marginTop: 8,
                padding: 10,
                background: "var(--color-bg-input)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                fontSize: 10.5,
                lineHeight: 1.5,
                color: "var(--color-text-secondary)",
                overflow: "auto",
                maxHeight: 200,
                whiteSpace: "pre-wrap",
              }}>{String(this.state.err.stack || this.state.err.message)}</pre>
            </details>
            <button
              type="button"
              className="proto-stage-btn proto-stage-btn-primary"
              onClick={this.reset}
            >
              Reset pane
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
