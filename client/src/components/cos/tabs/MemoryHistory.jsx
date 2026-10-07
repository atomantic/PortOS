import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as api from '../../../services/api';
import { useSocketResource } from '../../../hooks/useSocketResource';
import { usePagedCollection } from '../../../hooks/usePagedCollection';
import { formatCount, formatDateTime } from '../../../utils/formatters';
import InfiniteScrollFooter from '../../ui/InfiniteScrollFooter';

const HISTORY_EVENTS = ['cos:memory:updated', 'cos:memory:deleted'];

export default function MemoryHistory({ memory }) {
  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const offset = cursor ?? 0;
    const { versions } = await api.getMemoryVersions(memory.id, offset, { signal, silent: true });
    return { items: versions.map(item => ({ ...item, id: item.version })),
      nextCursor: versions.length === 20 ? offset + versions.length : null };
  }, [memory.id]);
  const page = usePagedCollection(fetchPage);
  useSocketResource(() => page.refreshFirst(), {
    namespace: 'cos', events: HISTORY_EVENTS, resourceKey: memory.id,
    immediate: false, matchesEvent: payload => payload?.id === memory.id
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const versionParam = searchParams.get('version');
  const parsedVersion = Number(versionParam);
  const selectedVersion = Number.isInteger(parsedVersion) && parsedVersion > 0 ? parsedVersion : null;
  const setSelectedVersion = version => setSearchParams(previous => {
    const next = new URLSearchParams(previous);
    next.set('version', String(version));
    return next;
  });
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError(null);
    if (selectedVersion !== null) {
      api.getMemoryVersion(memory.id, selectedVersion, { silent: true })
        .then(value => { if (active) setSnapshot(value); })
        .catch(err => { if (active) setError(err.message); });
    }
    return () => { active = false; };
  }, [memory.id, selectedVersion]);

  return <section aria-label="Memory history" className="space-y-2 border-t border-port-border pt-4">
    {memory.status === 'archived' && <div className="text-sm">
      {memory.archiveReason && <p>{memory.archiveReason}</p>}
      {memory.supersededBy?.map(id => <Link key={id} to={`/cos/memory/${encodeURIComponent(id)}`}
        className="block min-h-[44px] py-3 text-port-accent">View replacement memory</Link>)}
    </div>}
    <h3 className="text-sm font-medium">History · current version {formatCount(memory.version)}</h3>
    <p className="text-xs text-port-text-muted">History is stored on this machine. Times show when earlier text was replaced.</p>
    <ul>
      {page.items.map(item => <li key={item.version}>
        <button type="button" onClick={() => setSelectedVersion(item.version)}
          className="min-h-[44px] py-2 text-left text-sm text-port-accent">
          Version {formatCount(item.version)} · {formatDateTime(item.createdAt)}
          {item.changeReason && <span className="block text-port-text-muted">{item.changeReason}</span>}
          {item.changedBy && <span className="block text-port-text-muted">{item.changedBy}</span>}
        </button>
      </li>)}
    </ul>
    <InfiniteScrollFooter hasMore={page.hasMore} loading={page.loading} error={page.error}
      onLoadMore={page.loadMore} label="Load older versions" endLabel="No more versions" autoLoad={false} />
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {selectedVersion !== null && !snapshot && !error && <p role="status">Loading earlier text…</p>}
    {snapshot && <article className="space-y-2 rounded-lg bg-port-bg p-3">
      <h4>Version {formatCount(snapshot.version)}</h4>
      <p className="text-sm text-port-text-muted">{snapshot.type} · {snapshot.category}</p>
      <p className="text-sm">{snapshot.summary}</p>
      <p className="whitespace-pre-wrap break-words text-sm">{snapshot.content}</p>
      <p className="text-xs text-port-text-muted">{snapshot.tags?.join(', ')}</p>
    </article>}
  </section>;
}
