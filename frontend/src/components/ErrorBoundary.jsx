import { Component } from "react";
import { Button, Callout } from "./ui.jsx";

/**
 * Catches a page that fails to render, so the console shows what went wrong (and keeps
 * its sidebar) instead of a blank white page. Keyed by route in App, so moving to
 * another page starts clean.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in the browser console for a bug report; nothing is sent anywhere.
    console.error("Page failed to render:", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page">
        <Callout
          tone="danger"
          title="This page couldn't be shown"
          detail={String(error?.stack ?? error).slice(0, 2000)}
        >
          Something went wrong while drawing this page. Reloading usually fixes
          it; if it keeps happening, the details below show what failed.
        </Callout>
        <div className="row mt-sm">
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
