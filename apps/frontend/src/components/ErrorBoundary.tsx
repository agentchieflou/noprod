import { Component, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import { panelFaults, subscribeFaults } from '../notify';

interface Props { name: string; children: ReactNode; top?: boolean }

// Catches a render error below it. A panel shows a notice with Reload, which
// renders it again; the top-level one covers the whole app.
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`${this.props.name} hit an error`, error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const { name, top } = this.props;
    return (
      <div className={`panel-error ${top ? 'panel-error-top' : ''}`} role="alert" data-panel-error={name}>
        <strong>{top ? 'NoProd hit an error' : 'This panel hit an error'}</strong>
        <span className="panel-error-detail">{this.state.error.message}</span>
        <button className="designer-button" onClick={() => (top ? location.reload() : this.setState({ error: null }))}>Reload</button>
      </div>
    );
  }
}

function Fault({ name }: { name: string }) {
  useSyncExternalStore(subscribeFaults, () => panelFaults.has(name));
  if (panelFaults.has(name)) throw new Error(`test fault in ${name}`);
  return null;
}

// A panel with its own boundary, so one failing doesn't take the rest down
export function Panel({ name, children }: { name: string; children: ReactNode }) {
  return <ErrorBoundary name={name}><Fault name={name} />{children}</ErrorBoundary>;
}
