import { useLocation, useNavigate } from 'react-router';
import ErrorBoundary from './ErrorBoundary';
import { isStaleChunkError, reloadOnceForStaleChunk } from '../utils/staleChunkReload';

export default function PageErrorBoundary({ children }) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <ErrorBoundary
      resetKey={location.key}
      fallback={(error, resetError) => (
        <section role="alert" className="bg-port-card border border-port-border rounded-xl p-6 max-w-lg max-h-full overflow-y-auto mx-auto text-port-text">
          <h1 className="text-xl font-bold mb-2">This page hit an error</h1>
          <p className="text-sm text-port-text-muted mb-4">
            An error occurred while rendering <code className="break-all">{location.pathname}</code>. You can retry or use navigation to open another page.
          </p>
          <details className="mb-4">
            <summary className="cursor-pointer">Error details</summary>
            <pre className="text-xs whitespace-pre-wrap break-all mt-2">{error?.message || 'Unknown error'}</pre>
          </details>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent rounded-lg"
              onClick={async () => {
                if (isStaleChunkError(error, { duringRender: true })) {
                  const reloaded = await reloadOnceForStaleChunk({ forceCachePurge: true });
                  if (reloaded) return;
                  window.location.reload();
                  return;
                }
                resetError();
              }}
            >
              Retry
            </button>
            <button type="button" onClick={() => navigate('/')} className="px-4 py-2 border border-port-border hover:bg-port-card-hover rounded-lg">
              Go to dashboard
            </button>
          </div>
        </section>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
