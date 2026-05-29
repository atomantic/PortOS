import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';
import Banner from './ui/Banner';
import { isStaleChunkError, reloadOnceForStaleChunk } from '../utils/staleChunkReload';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (isStaleChunkError(error) && reloadOnceForStaleChunk()) return;
    console.error(`💥 React Error: ${error.message}`, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-port-bg flex items-center justify-center p-4">
          <div className="bg-port-card border border-port-border rounded-xl p-8 max-w-md w-full">
            <div className="flex items-center justify-center mb-4">
              <AlertTriangle size={32} className="text-port-error" />
            </div>
            <h1 className="text-xl font-bold text-port-text text-center mb-2">Something went wrong</h1>
            <p className="text-port-text-muted text-sm text-center mb-4">
              An unexpected error occurred. Please try refreshing the page.
            </p>
            {this.state.error && (
              <Banner tone="error" size="md" className="mb-4">
                <p className="text-xs font-mono break-all">
                  {this.state.error.message}
                </p>
              </Banner>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent rounded-lg transition-colors"
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
