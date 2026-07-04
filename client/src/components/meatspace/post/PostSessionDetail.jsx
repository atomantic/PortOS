import { useState, useEffect } from 'react';
import { ArrowLeft, Loader, AlertCircle } from 'lucide-react';
import { getPostSession } from '../../../services/api';
import PostSessionSummary from './PostSessionSummary';

// Deep-linkable view of ANY saved session (/post/session/:id). Reached after a
// just-completed session saves, and from a History row — the same summary the
// post-save screen shows, minus the Save button. A stale/deleted id renders a
// not-found fallback (URL-is-source-of-truth convention).
export default function PostSessionDetail({ id, onBack }) {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | notfound

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    getPostSession(id)
      .then(s => {
        if (cancelled) return;
        if (s) { setSession(s); setStatus('ready'); }
        else setStatus('notfound');
      })
      .catch(() => { if (!cancelled) setStatus('notfound'); });
    return () => { cancelled = true; };
  }, [id]);

  if (status === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader size={32} className="text-port-accent animate-spin" />
        <div className="text-gray-400">Loading session...</div>
      </div>
    );
  }

  if (status === 'notfound') {
    return (
      <div className="max-w-lg mx-auto flex flex-col items-center justify-center h-64 gap-3 text-center">
        <AlertCircle size={32} className="text-port-warning" />
        <div className="text-white font-medium">Session not found</div>
        <p className="text-sm text-gray-500">This session may have been deleted, or the link is stale.</p>
        <button
          onClick={onBack}
          className="mt-2 flex items-center gap-2 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors"
        >
          <ArrowLeft size={16} />
          Back to History
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors" aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <h2 className="text-xl font-bold text-white">Session</h2>
        <span className="text-sm text-gray-500">{session.date}</span>
      </div>

      <PostSessionSummary drillResults={session.tasks || []} sessionScore={session.score || 0} />
    </div>
  );
}
