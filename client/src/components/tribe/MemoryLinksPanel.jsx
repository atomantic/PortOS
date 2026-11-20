import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { getTribeMemoryLinks, linkTribeMemory, unlinkTribeMemory } from '../../services/apiTribe.js';
import { getMemories } from '../../services/apiMemory.js';
import toast from '../ui/Toast';
import ListLoadError from '../ui/ListLoadError';

export default function MemoryLinksPanel({ personId }) {
  const [links, setLinks] = useState([]);
  const [memories, setMemories] = useState([]);
  const [memoryId, setMemoryId] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  // Each read fails on its own: a failed link read must not say "No memories linked yet",
  // nor a failed picker read render an empty picker.
  const [linksError, setLinksError] = useState(null);
  const [memoriesError, setMemoriesError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!personId) return;
    let cancelled = false;
    setLoading(true);
    setLinksError(null);
    setMemoriesError(null);
    const asError = (err) => (err instanceof Error ? err : new Error('Request failed'));
    Promise.all([
      getTribeMemoryLinks(personId, { silent: true })
        .then((result) => { if (!cancelled) setLinks(result?.links || []); })
        .catch((err) => { if (!cancelled) setLinksError(asError(err)); }),
      getMemories({ limit: 25, sortBy: 'updatedAt', sortOrder: 'desc' }, { silent: true })
        .then((result) => { if (!cancelled) setMemories(result?.memories || []); })
        .catch((err) => { if (!cancelled) setMemoriesError(asError(err)); }),
    ]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [personId, attempt]);
  const retry = () => setAttempt((n) => n + 1);

  const linkMemory = async () => {
    if (!memoryId) return;
    const result = await linkTribeMemory(personId, { memoryId, note }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to link memory');
      return null;
    });
    if (!result) return;
    setLinks(result.links || []);
    setMemoryId('');
    setNote('');
  };

  const unlinkMemory = async (id) => {
    const result = await unlinkTribeMemory(personId, id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to unlink memory');
      return null;
    });
    if (!result?.success) return;
    setLinks((current) => current.filter((link) => link.memoryId !== id));
  };

  return (
    <section className="mt-4 border border-port-border bg-port-card rounded p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Brain Memories</h2>
        {loading && <span className="text-xs text-gray-500">Loading</span>}
      </div>
      <div className="mt-3 grid gap-2">
        {memoriesError && <ListLoadError what="recent memories" error={memoriesError} onRetry={retry} retrying={loading} />}
        <select
          aria-label="Brain memory"
          value={memoryId}
          onChange={(event) => setMemoryId(event.target.value)}
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
        >
          <option value="">Select recent memory</option>
          {memories.map((memory) => (
            <option key={memory.id} value={memory.id}>{memory.summary || memory.id}</option>
          ))}
        </select>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-label="Why this memory matters"
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
          placeholder="Why this memory matters"
        />
        <button
          type="button"
          onClick={linkMemory}
          disabled={!memoryId}
          className="inline-flex items-center justify-center gap-2 rounded border border-port-border px-3 py-2 text-sm text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-50"
        >
          <Plus size={15} aria-hidden="true" />
          Link Memory
        </button>
      </div>

      <div className="mt-4 grid gap-2">
        {linksError && <ListLoadError what="linked memories" error={linksError} onRetry={retry} retrying={loading} />}
        {links.length ? links.map((link) => (
          <div key={link.memoryId} className="rounded border border-port-border bg-port-bg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white line-clamp-2">{link.memory?.summary || link.memoryId}</p>
                {link.note && <p className="mt-1 text-xs text-gray-500">{link.note}</p>}
              </div>
              <button
                type="button"
                onClick={() => unlinkMemory(link.memoryId)}
                title="Unlink memory"
                aria-label="Unlink memory"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0 rounded p-1 text-gray-500 hover:text-rose-300"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )) : !linksError && !loading && (
          <p className="text-sm text-gray-500">No memories linked yet.</p>
        )}
      </div>
    </section>
  );
}
