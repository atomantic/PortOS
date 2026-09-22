import { useEffect, useRef } from 'react';
import BrailleSpinner from '../BrailleSpinner';

// The observer respects ancestor scroll containers. A real button remains for
// keyboard users, unavailable observers, and retries (never auto-retry errors).
export default function InfiniteScrollFooter({ hasMore, loading, error, onLoadMore, autoLoad = true, label = 'Load more', endLabel = 'All results loaded' }) {
  const sentinel = useRef(null);
  useEffect(() => {
    if (!autoLoad || !hasMore || loading || error || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMore();
    }, { rootMargin: '200px' });
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [autoLoad, hasMore, loading, error, onLoadMore]);
  return <div ref={sentinel} className="col-span-full py-3 text-center">
    {error && <p role="alert" className="mb-2 text-sm text-port-error">{(typeof error === 'string' ? error : error.message) || 'Unable to load results'}</p>}
    {loading ? <div role="status"><BrailleSpinner text="Loading" /></div>
      : hasMore || error ? <button type="button" onClick={onLoadMore}
        className="min-h-[44px] rounded-lg border border-port-border px-4 py-2 text-sm text-port-accent hover:text-port-text">
        {error ? 'Retry loading' : label}
      </button> : <p role="status" className="text-xs text-port-text-muted">{endLabel}</p>}
  </div>;
}
