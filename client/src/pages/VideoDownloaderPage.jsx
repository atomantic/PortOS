import { useState } from 'react';
import PageHeader from '../components/PageHeader';
import { Download, Film, Loader2, Trash2, ExternalLink, Video } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import ListLoadError from '../components/ui/ListLoadError';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import YtDlpUpdateCard from '../components/video/YtDlpUpdateCard';
import useVideoDownload from '../hooks/useVideoDownload.js';
import useConfirmDelete from '../hooks/useConfirmDelete.js';
import useListResource from '../hooks/useListResource';
import { listVideoDownloads, deleteVideoDownload } from '../services/apiVideoDownload.js';
import { cancelVideoPendingDelete } from '../services/apiImageVideo.js';
import usePendingDeletePeerNames from '../hooks/usePendingDeletePeerNames.js';
import { timeAgo, formatTimecode } from '../utils/formatters';
import { mediaDeleteOutcome } from '../lib/mediaDeleteOutcome';

const loadVideoDownloads = () => listVideoDownloads({ silent: true });

// Dev Tools video downloader (#1946) — paste a YouTube or x.com/Twitter URL,
// download the full video via yt-dlp into data/videos (where it also shows up in
// the media gallery), and browse/delete what's been downloaded.
export default function VideoDownloaderPage() {
  const [url, setUrl] = useState('');
  const downloadsResource = useListResource(loadVideoDownloads);
  const {
    items: downloads, state, error, retry, setItems: setDownloads,
  } = downloadsResource;
  const [deletingId, setDeletingId] = useState(null);
  // Thumbnail filenames that failed to load; keyed by value so a new thumbnail retries.
  const [failedThumbs, setFailedThumbs] = useState(() => new Set());
  const { peerNames, rememberPeerName } = usePendingDeletePeerNames(downloads);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  // Prepend the finished clip to the list rather than refetching (reactive UI).
  const { active, percent, stage, start, cancel } = useVideoDownload({
    onComplete: (video) => {
      if (video) setDownloads((prev) => [video, ...prev.filter((d) => d.id !== video.id)]);
      setUrl('');
    },
  });

  const onSubmit = (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || active) return;
    start(trimmed);
  };

  const setPendingDelete = (id, pendingDelete) => setDownloads((prev) => prev.map((d) => {
    if (d.id !== id) return d;
    const { pendingDelete: _previous, ...rest } = d;
    return pendingDelete ? { ...rest, pendingDelete } : rest;
  }));

  const onCancelPendingDelete = async (id) => {
    const cancelled = await cancelVideoPendingDelete(id, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Cancel failed'); return false; });
    if (!cancelled) return;
    setPendingDelete(id, null);
    toast.success('Pending delete cancelled');
  };

  const onDelete = (id) => confirmDelete(async () => {
    setDeletingId(id);
    await deleteVideoDownload(id, { silent: true })
      .then((result) => {
        // A peer's download is deleted on its owner; one still waiting on it stays listed.
        const outcome = mediaDeleteOutcome(result, 'video');
        if (outcome.remove) setDownloads((prev) => prev.filter((d) => d.id !== id));
        else {
          rememberPeerName(outcome.pendingDelete?.peerId, result.peerName);
          setPendingDelete(id, outcome.pendingDelete);
        }
        if (outcome.tone === 'info') toast(outcome.notice);
      })
      .catch((err) => toast.error(err?.message || 'Failed to delete video'))
      .finally(() => setDeletingId(null));
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Film}
        title="Video Downloader"
        subtitle="Download a full video from a YouTube or x.com/Twitter URL. Downloaded clips also appear in your media gallery."
      />
      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto space-y-6">

      <YtDlpUpdateCard />

      <form onSubmit={onSubmit} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
        <label htmlFor="video-download-url" className="block text-sm text-gray-300">
          Video URL
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="video-download-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=… or https://x.com/…/status/…"
            disabled={active}
            className="flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={active || !url.trim()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm rounded bg-port-accent hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {active ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {active ? 'Downloading…' : 'Download'}
          </button>
        </div>

        {active && (
          <div className="flex items-center gap-3 text-[12px] text-port-accent">
            <Loader2 size={14} className="animate-spin shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {stage ? `${stage}…` : 'Downloading…'} {percent > 0 ? `${percent}%` : ''}
                </span>
                <button type="button" onClick={cancel} className="text-gray-400 hover:text-white shrink-0">
                  Cancel
                </button>
              </div>
              <div className="mt-1 h-1 bg-port-border rounded overflow-hidden">
                <div className="h-full bg-port-accent transition-all" style={{ width: `${percent}%` }} />
              </div>
            </div>
          </div>
        )}
        <p className="text-[11px] text-gray-500">
          x.com/Twitter downloads are best-effort — login-walled or rate-limited posts may fail.
        </p>
      </form>

      <section>
        <h2 className="text-sm font-semibold text-gray-300 mb-2">Downloaded ({downloads.length})</h2>
        {state === 'loading' ? (
          <p className="text-sm"><BrailleSpinner text="Loading…" /></p>
        ) : state === 'error' ? (
          <ListLoadError what="downloads" error={error} onRetry={retry} />
        ) : downloads.length === 0 ? (
          <p className="text-sm text-gray-500">No videos downloaded yet.</p>
        ) : (
          <ul className="space-y-2">
            {downloads.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 bg-port-card border border-port-border rounded-lg p-3"
              >
                <a
                  href={`/data/videos/${d.filename}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 block w-28 aspect-video rounded overflow-hidden bg-port-bg border border-port-border"
                >
                  {d.thumbnail && !failedThumbs.has(d.thumbnail) ? (
                    <img
                      src={`/data/video-thumbnails/${d.thumbnail}`}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={() => setFailedThumbs((prev) => new Set(prev).add(d.thumbnail))}
                    />
                  ) : (
                    <span className="w-full h-full flex items-center justify-center text-gray-600">
                      <Video size={20} />
                    </span>
                  )}
                </a>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate" title={d.title}>{d.title || 'Downloaded video'}</p>
                  <div className="text-[11px] text-gray-500 flex items-center gap-2 mt-0.5">
                    <span>{timeAgo(d.createdAt)}</span>
                    {d.durationSec != null && <span>· {formatTimecode(d.durationSec)}</span>}
                  </div>
                  {d.sourceUrl && (
                    <a
                      href={d.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-port-accent hover:underline inline-flex items-center gap-1 mt-0.5 max-w-full truncate"
                      title={d.sourceUrl}
                    >
                      <ExternalLink size={11} className="shrink-0" />
                      <span className="truncate">{d.sourceUrl}</span>
                    </a>
                  )}
                </div>
                <div className="shrink-0">
                  {d.pendingDelete ? (
                    <div className="flex flex-col items-end gap-1 text-[11px] text-port-warning">
                      <span role="status">Delete pending on {(d.pendingDelete.peerId && peerNames[d.pendingDelete.peerId]) || 'the owning machine'}</span>
                      <button
                        type="button"
                        onClick={() => onCancelPendingDelete(d.id)}
                        aria-label="Cancel pending delete"
                        className="min-h-[44px] px-2 text-port-accent hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : isConfirming(d.id) ? (
                    <ConfirmButtonPair
                      prompt="Delete?"
                      busy={deletingId === d.id}
                      busyText="Deleting"
                      onConfirm={() => onDelete(d.id)}
                      onCancel={cancelDelete}
                      ariaLabel={`Delete ${d.title || 'video'}`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => requestDelete(d.id)}
                      className="p-2 text-gray-400 hover:text-port-error transition-colors"
                      aria-label={`Delete ${d.title || 'video'}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
      </div>
    </div>
  );
}
