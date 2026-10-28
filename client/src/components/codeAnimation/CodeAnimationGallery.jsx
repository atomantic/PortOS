import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, FileCode2, ImageOff, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import useMounted from '../../hooks/useMounted';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import socket from '../../services/socket';
import { codeAnimationPosterUrl, deleteCodeAnimationJob, listCodeAnimationJobPage, requestCodeAnimationPoster } from '../../services/api';
import { formatCount, timeAgo } from '../../utils/formatters';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import toast from '../ui/Toast';

const STATUS = {
  running: { icon: Clock3, label: 'In progress', tone: 'text-port-accent' },
  completed: { icon: CheckCircle2, label: 'Completed', tone: 'text-port-success' },
  failed: { icon: AlertTriangle, label: 'Failed', tone: 'text-port-error' },
};

function PosterPlaceholder({ item, capturing }) {
  if (item.status === 'running') {
    return <LoaderCircle className="h-8 w-8 animate-spin text-port-accent" aria-hidden="true" />;
  }
  if (item.status === 'failed') return <AlertTriangle className="h-8 w-8 text-port-error" aria-hidden="true" />;
  if (capturing) {
    return (
      <span className="flex flex-col items-center gap-2 text-xs text-gray-400">
        <LoaderCircle className="h-6 w-6 animate-spin" aria-hidden="true" /> Drawing thumbnail…
      </span>
    );
  }
  return <ImageOff className="h-8 w-8 text-gray-600" aria-hidden="true" />;
}

function GalleryCard({ item, capturing, confirming, deleting, onRequestDelete, onCancelDelete, onConfirmDelete }) {
  const status = STATUS[item.status] || STATUS.failed;
  const StatusIcon = status.icon;
  const title = item.title || 'Untitled animation';
  return (
    <div className="relative min-w-0">
      <Link
        to={`/code-animation/${encodeURIComponent(item.id)}`}
        className="group block min-w-0 overflow-hidden rounded-xl border border-port-border bg-port-card transition-colors hover:border-port-accent"
      >
        <div className="relative flex aspect-video items-center justify-center bg-black">
          {item.posterVersion
            ? <img src={codeAnimationPosterUrl(item.id, item.posterVersion)} alt="" loading="lazy" className="h-full w-full object-contain" />
            : <PosterPlaceholder item={item} capturing={capturing} />}
          {item.status !== 'completed' && (
            <span className="port-media-overlay absolute left-2 top-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs">
              <StatusIcon className={`h-3 w-3 ${status.tone}`} aria-hidden="true" /> {status.label}
            </span>
          )}
        </div>
        <div className="space-y-1 p-3">
          <p className="truncate text-sm font-medium text-white group-hover:text-port-accent">{title}</p>
          <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
            <span className="min-w-0 truncate">{item.status === 'completed' ? (item.model || 'Completed') : status.label}</span>
            <span className="shrink-0">{timeAgo(item.createdAt)}</span>
          </div>
        </div>
      </Link>
      {/* A generating animation can't be deleted until it finishes. */}
      {item.status !== 'running' && !confirming && (
        <button type="button" onClick={() => onRequestDelete(item.id)} disabled={deleting}
          aria-label={`Delete ${title}`}
          className="port-media-overlay absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-200 hover:text-port-error disabled:opacity-40">
          {deleting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
        </button>
      )}
      {confirming && (
        <InlineConfirmRow
          className="mt-2"
          autoFocus
          aria-label={`Delete ${title}?`}
          question={`Delete “${title}”? Its files go to the Trash.`}
          onConfirm={() => onConfirmDelete(item)}
          onCancel={onCancelDelete}
        />
      )}
    </div>
  );
}

/** Every saved Fast HTML generation, newest first, each opening its job route. */
export default function CodeAnimationGallery() {
  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const page = await listCodeAnimationJobPage({ cursor, signal });
    return { ...page, meta: page.counts };
  }, []);
  const gallery = usePagedCollection(fetchPage);
  const { items, setItems, removeItem, reload, refreshFirst } = gallery;
  useSocketSubscription('code-animation', { onResubscribe: reload });
  useEffect(() => {
    const refresh = (event) => {
      if (event?.kind === 'deleted' && event.id) removeItem(event.id);
      else refreshFirst();
    };
    socket.on('code-animation:changed', refresh);
    return () => socket.off('code-animation:changed', refresh);
  }, [refreshFirst, removeItem]);

  // A completed job with no poster (one from before posters existed, or whose
  // capture was interrupted) gets one request per visit. Requests go one at a
  // time: each is held open while the server draws, and a burst would occupy
  // every browser connection to this origin. The mount guard is lifetime-scoped
  // on purpose: this effect re-runs on every items change, which must not drop
  // an in-flight answer.
  const mounted = useMounted();
  const requested = useRef(new Set());
  const queue = useRef(Promise.resolve());
  const [capturing, setCapturing] = useState(() => new Set());
  useEffect(() => {
    const missing = items.filter((item) => item.status === 'completed' && !item.posterVersion && !requested.current.has(item.id));
    if (!missing.length) return;
    setCapturing((previous) => new Set([...previous, ...missing.map((item) => item.id)]));
    for (const { id } of missing) {
      requested.current.add(id);
      queue.current = queue.current.then(() => {
        if (!mounted.current) return null;
        return requestCodeAnimationPoster(id, { silent: true })
          .then(({ posterVersion }) => posterVersion)
          .catch(() => null)
          .then((posterVersion) => {
            if (!mounted.current) return;
            setCapturing((previous) => { const next = new Set(previous); next.delete(id); return next; });
            if (posterVersion) setItems((previous) => previous.map((entry) => (entry.id === id ? { ...entry, posterVersion } : entry)));
          });
      });
    }
  }, [items, setItems, mounted]);

  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [deleting, setDeleting] = useState(() => new Set());
  const handleDelete = (item) => confirmDelete(async () => {
    setDeleting((previous) => new Set(previous).add(item.id));
    const done = await deleteCodeAnimationJob(item.id, { silent: true })
      .catch((error) => { toast.error(error.message || 'Could not delete the animation'); return null; });
    if (!mounted.current) return;
    setDeleting((previous) => { const next = new Set(previous); next.delete(item.id); return next; });
    if (!done) return;
    removeItem(item.id);
    toast.success(`Deleted ${item.title || 'the animation'}`);
  });

  const counts = gallery.meta || { running: 0, completed: 0 };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          {formatCount(counts.completed, { fallback: '0' })} completed · {formatCount(counts.running, { fallback: '0' })} in progress
        </p>
        <Link
          to="/code-animation"
          className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-3 py-1.5 text-sm text-white hover:opacity-90"
        >
          <Sparkles className="h-4 w-4" /> New animation
        </Link>
      </div>
      {!gallery.loaded && <p className="text-sm text-gray-500">Loading animations…</p>}
      {gallery.loaded && items.length === 0 && !gallery.error && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-port-border p-10 text-center">
          <FileCode2 className="h-8 w-8 text-gray-600" aria-hidden="true" />
          <p className="text-sm text-gray-400">Animations you generate in Fast HTML appear here.</p>
        </div>
      )}
      {items.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {items.map((item) => (
            <GalleryCard key={item.id} item={item} capturing={capturing.has(item.id)}
              confirming={isConfirming(item.id)} deleting={deleting.has(item.id)}
              onRequestDelete={requestDelete} onCancelDelete={cancelDelete} onConfirmDelete={handleDelete} />
          ))}
        </div>
      )}
      <InfiniteScrollFooter hasMore={gallery.hasMore} loading={gallery.loading} error={gallery.error}
        onLoadMore={gallery.loadMore} label="Load older animations" />
    </div>
  );
}
