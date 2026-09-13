import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import { useSocket } from '../../hooks';
import { getYtDlpStatus, updateYtDlp } from '../../services/apiVideoDownload.js';

/**
 * yt-dlp version + one-click update, on the Video Downloader page.
 *
 * YouTube gates media URLs behind a player handshake that yt-dlp tracks
 * release-to-release, so a binary only weeks old fails downloads the browser
 * plays fine. The failure message already names the remedy (#7255); this is the
 * remedy itself, next to the field that hit it — the same affordance the Local
 * LLMs page gives llama.cpp and Ollama.
 */
export default function YtDlpUpdateCard() {
  const socket = useSocket();
  const [status, setStatus] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState('');

  const refresh = useCallback(
    () => getYtDlpStatus({ silent: true }).then(setStatus).catch(() => setStatus(null)),
    [],
  );

  useEffect(() => { refresh(); }, [refresh]);

  // `brew upgrade` relays its own output while it runs, so the button can show
  // what it's doing rather than spinning silently for a minute.
  useEffect(() => {
    const onFrame = (frame) => {
      if (frame?.event === 'progress' && frame.message) setProgress(String(frame.message).trim());
    };
    socket.on('ytdlp:update', onFrame);
    return () => socket.off('ytdlp:update', onFrame);
  }, [socket]);

  const onUpdate = async () => {
    setUpdating(true);
    setProgress('');
    await updateYtDlp({ silent: true })
      .then((result) => {
        toast.success(result?.note ? `yt-dlp ${result.note}` : `yt-dlp updated to ${result?.version || 'the latest release'}`);
        return refresh();
      })
      .catch((err) => toast.error(err?.message || 'yt-dlp update failed'))
      .finally(() => {
        setUpdating(false);
        setProgress('');
      });
  };

  // Nothing known yet — stay silent rather than flashing a "not installed" claim
  // the first response may contradict.
  if (!status) return null;

  const outdated = status.installed && status.updateAvailable;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 flex items-center gap-2">
          {status.installed ? (
            outdated
              ? <AlertTriangle size={14} className="text-port-warning shrink-0" />
              : <CheckCircle2 size={14} className="text-port-success shrink-0" />
          ) : (
            <AlertTriangle size={14} className="text-port-error shrink-0" />
          )}
          <span className="truncate">
            {status.installed
              ? `yt-dlp ${status.version || 'installed'}`
              : 'yt-dlp is not installed'}
            {outdated && status.latestVersion ? ` — ${status.latestVersion} is available` : ''}
          </span>
        </p>
        <p className="text-[11px] text-gray-500 mt-0.5 truncate">
          {progress
            || status.blockedReason
            || (outdated
              ? 'A stale yt-dlp is the usual cause of a failed YouTube download.'
              : status.installed
                ? `Up to date via ${status.methodLabel}.`
                : null)}
        </p>
      </div>
      {status.installed && status.canUpdate && (
        <button
          type="button"
          onClick={onUpdate}
          disabled={updating}
          className={`shrink-0 inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            outdated ? 'bg-port-accent hover:bg-blue-600 text-white' : 'border border-port-border text-gray-300 hover:text-white'
          }`}
        >
          {updating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {updating ? 'Updating…' : 'Update yt-dlp'}
        </button>
      )}
      {!status.installed && status.downloadUrl && (
        <a
          href={status.downloadUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 px-3 py-1.5 text-sm rounded border border-port-border text-gray-300 hover:text-white transition-colors"
        >
          Install instructions
        </a>
      )}
    </div>
  );
}
