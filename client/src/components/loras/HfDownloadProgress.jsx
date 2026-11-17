import ProgressBar from '../ui/ProgressBar';
import { formatBytes } from '../../utils/formatters';
import { pctOf } from './loraDisplay';

// Byte-level download progress bar for an in-flight HuggingFace LoRA install.
// `progress` is `{ received, total, progress }` (progress 0..1) or null. When
// the server had no Content-Length (total 0 / progress null) the bar renders an
// indeterminate pulse instead of a fill.
export default function HfDownloadProgress({ progress }) {
  const pct = pctOf(progress);
  const total = progress?.total || 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-gray-400">
        <span>{pct != null ? `Downloading… ${pct}%` : 'Downloading…'}</span>
        {total > 0 && (
          <span className="font-mono text-gray-500">{formatBytes(progress.received)} / {formatBytes(total)}</span>
        )}
      </div>
      <ProgressBar percent={pct} label="Download progress" duration={200} />
    </div>
  );
}
