/**
 * The explicit Real-ESRGAN setup control (#19985), shared by the upscale drawer
 * and the Music Video final-upgrade panel. Pressing it is the only thing that
 * downloads the runtime: it opens the server's install stream (pinned release,
 * SHA-256 check, a per-weight GPU check) and reports progress inline.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { formatBytes } from '../../utils/formatters';
import { useSseProgress } from '../../hooks/useSseProgress';
import { realesrganInstallUrl } from '../../services/apiImageVideo';

export default function RealesrganInstallButton({ installTarget, onInstalled, label = 'Install Real-ESRGAN' }) {
  const [running, setRunning] = useState(false);
  const stream = useSseProgress(running ? realesrganInstallUrl() : null, { enabled: running, method: 'POST', maxFrames: 0 });
  const frame = stream.latest;

  useEffect(() => {
    if (!running || !stream.closed || !frame) return;
    setRunning(false);
    if (frame.type === 'complete') {
      toast.success(frame.message || 'Real-ESRGAN is ready');
      onInstalled?.();
    } else {
      toast.error(frame.message || 'Real-ESRGAN install failed');
    }
  }, [running, stream.closed, frame, onInstalled]);

  if (running) {
    const percent = frame?.type === 'progress' && typeof frame.progress === 'number' ? Math.round(frame.progress * 100) : null;
    return (
      <span role="status" className="inline-flex items-center gap-1 text-gray-400">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
        {frame?.type === 'progress' ? `Downloading${percent != null ? ` ${percent}%` : ''}…` : frame?.message || 'Starting install…'}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setRunning(true)}
      className="px-2 py-1 rounded border border-port-border text-port-accent hover:text-white hover:border-port-accent/60 min-h-[44px] pointer-fine:sm:min-h-0"
    >
      {label}{installTarget?.sizeBytes ? ` (${formatBytes(installTarget.sizeBytes)})` : ''}
    </button>
  );
}
