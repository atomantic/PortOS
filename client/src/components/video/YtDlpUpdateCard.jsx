import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import { useSocket } from '../../hooks/useSocket.js';
import { getYtDlpStatus, installYtDlp, updateYtDlp } from '../../services/apiVideoDownload.js';

/**
 * yt-dlp version + one-click installation and update, on the Video Downloader page.
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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const refresh = useCallback(
    () => getYtDlpStatus({ silent: true }).then(setStatus).catch(() => setStatus(null)),
    [],
  );

  useEffect(() => { refresh(); }, [refresh]);

  // Homebrew streams output while a package change is running.
  useEffect(() => {
    const onFrame = (frame) => {
      if (frame?.event === 'progress' && frame.message) setProgress(String(frame.message).trim());
    };
    socket.on('ytdlp:update', onFrame);
    return () => socket.off('ytdlp:update', onFrame);
  }, [socket]);

  const onAction = async () => {
    const installing = !status.installed;
    const action = installing ? installYtDlp : updateYtDlp;
    setBusy(true);
    setProgress('');
    await action({ silent: true })
      .then((result) => {
        const verb = installing ? 'installed' : 'updated';
        toast.success(result?.note ? `yt-dlp ${result.note}` : `yt-dlp ${verb}${result?.version ? ` (${result.version})` : ''}`);
        return refresh();
      })
      .catch((err) => toast.error(err?.message || `yt-dlp ${installing ? 'installation' : 'update'} failed`))
      .finally(() => {
        setBusy(false);
        setProgress('');
      });
  };

  // Nothing known yet — stay silent rather than flashing a "not installed" claim
  // the first response may contradict.
  if (!status) return null;

  const canInstall = !status.installed && status.canInstall;
  const actionLabel = canInstall ? 'Install yt-dlp' : 'Update yt-dlp';
  const busyLabel = canInstall ? 'Installing…' : 'Updating…';
  const ActionIcon = canInstall ? Download : RefreshCw;
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
                : canInstall ? 'Install with Homebrew on the PortOS host.' : null)}
        </p>
      </div>
      {(canInstall || (status.installed && status.canUpdate)) && (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className={`shrink-0 inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            canInstall || outdated ? 'bg-port-accent hover:bg-blue-600 text-white' : 'border border-port-border text-gray-300 hover:text-white'
          }`}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ActionIcon size={14} />}
          {busy ? busyLabel : actionLabel}
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
