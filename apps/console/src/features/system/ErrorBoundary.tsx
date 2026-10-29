import { Component, type ReactNode } from 'react';
import { Disc } from '@/components/ui/disc';
// Loads the account registry at start-up: people and organisations created in this browser (sign-up,
// invitations, SSO), the extra demo accounts and password changes join the shared directory before any page reads it.
import '@/features/auth/registry';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas p-6">
        <div className="max-w-[560px] border border-line bg-surface p-8">
          <Disc kind="registration" size={48} />
          <p className="label mt-6">Something went wrong</p>
          <h1 className="mt-2 text-2xl font-bold">This page could not be shown</h1>
          <p className="mt-3 text-muted">The console hit an error while drawing this page. No decision, approval or record was changed by it. Reload the page; if it happens again, send the text below to support@elan1.ai.</p>
          <pre className="mt-4 p-3 bg-sunken border border-line text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">{this.state.error.message}</pre>
          <div className="mt-6 flex flex-wrap gap-2">
            <button className="h-10 px-4 bg-fg text-canvas font-medium" onClick={() => location.reload()}>Reload</button>
            <a className="h-10 px-4 inline-flex items-center border border-line-strong/70 font-medium" href="/">Go to Today</a>
            <a className="h-10 px-4 inline-flex items-center font-medium text-muted hover:text-fg" href="/status">Service status</a>
          </div>
        </div>
      </div>
    );
  }
}
