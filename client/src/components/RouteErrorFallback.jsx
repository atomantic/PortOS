import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useRouteError, isRouteErrorResponse } from 'react-router';
import Banner from './ui/Banner';
import { isStaleChunkError, reloadOnceForStaleChunk } from '../utils/staleChunkReload';

const getErrorMessage = (error) => {
  if (isRouteErrorResponse(error)) return error.statusText || `Request failed (${error.status})`;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The page could not be loaded.';
};

export default function RouteErrorFallback() {
  const error = useRouteError();
  const navigate = useNavigate();
  const message = getErrorMessage(error);

  const retry = async () => {
    if (isStaleChunkError(error, { duringRender: true })) {
      const reloaded = await reloadOnceForStaleChunk({ forceCachePurge: true });
      if (reloaded) return;
    }
    window.location.reload();
  };

  useEffect(() => {
    if (isStaleChunkError(error, { duringRender: true })) {
      void reloadOnceForStaleChunk();
    }
  }, [error]);

  return (
    <div className="min-h-dvh-cap bg-port-bg flex items-center justify-center p-4">
      <div className="bg-port-card border border-port-border rounded-xl p-8 max-w-lg w-full">
        <div className="flex items-center justify-center mb-4">
          <AlertTriangle size={32} className="text-port-error" />
        </div>
        <h1 className="text-xl font-bold text-port-text text-center mb-2">PortOS could not load this page</h1>
        <p className="text-port-text-muted text-sm text-center mb-4">
          The server may still be restarting, or this browser may have an outdated app asset. Try again in a moment.
        </p>
        <Banner tone="error" size="md" className="mb-4">
          <p className="text-xs font-mono break-all">{message}</p>
        </Banner>
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={retry}
            className="flex-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent rounded-lg transition-colors"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex-1 px-4 py-2 border border-port-border hover:bg-port-card-hover text-port-text rounded-lg transition-colors"
          >
            Go to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
