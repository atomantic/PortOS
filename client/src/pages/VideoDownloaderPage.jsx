import { useEffect, useState } from 'react';
import { Download, Film, Loader2, Trash2, ExternalLink, Video } from 'lucide-react';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useVideoDownload, useConfirmDelete } from '../hooks';
import { listVideoDownloads, deleteVideoDownload } from '../services/apiVideoDownload.js';
import { timeAgo, formatTimecode } from '../utils/formatters';

// Dev Tools video downloader (#1946) — paste a YouTube or x.com/Twitter URL,
// download the full video via yt-dlp into data/videos (where it also shows up in
// the media gallery), and browse/delete what's been downloaded.
export default function VideoDownloaderPage() {
  const [url, setUrl] = useState('');
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    listVideoDownloads()
      .then((list) => setDownloads(Array.isArray(list) ? list : []))
      .catch(() => setDownloads([]))
      .finally(() => setLoading(false));
  }, []);

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

  const onDelete = (id) => confirmDelete(async () => {
    setDeletingId(id);
    await deleteVideoDownload(id, { silent: true })
      .then(() => setDownloads((prev) => prev.filter((d) => d.id !== id)))
      .catch((err) => toast.error(err?.message || 'Failed to delete video'))
      .finally(() => setDeletingId(null));
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Film size={20} className="text-port-accent" /> Video Downloader
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          Download a full video from a YouTube or x.com/Twitter URL. Downloaded clips also appear in your media gallery.
        </p>
      </header>

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
        {loading ? (
          <p className="text-sm text-gray-500 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </p>
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
                  {d.thumbnail ? (
                    <img
                      src={`/data/video-thumbnails/${d.thumbnail}`}
                      alt=""
                      className="w-full h-full object-cover"
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
                  {isConfirming(d.id) ? (
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
  );
}
