import { formatCount, formatTimecode } from '../../utils/formatters.js';

const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const KIND_LABELS = { overlap: 'Collision', 'off-frame': 'Cut off', contrast: 'Hard to read', small: 'Too small' };
// The first few findings stay in view; the rest fold so the approval stays above the fold on a phone.
const SHOWN = 3;
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

function summaryOf(report) {
  switch (report.status) {
    case 'running': return { text: 'Checking the text in every shot…', tone: 'text-port-text-muted' };
    case 'none': return { text: 'Not checked yet.', tone: 'text-port-text-muted' };
    case 'interrupted': return { text: 'The last check was interrupted.', tone: 'text-port-warning' };
    case 'failed': return { text: `The check failed: ${report.error || 'no reason given'}`, tone: 'text-port-error' };
    default: break;
  }
  const { errors, warnings } = report.counts;
  if (!report.findings.length) return { text: `No problems in ${plural(report.textSamples ?? 0, 'frame')} with text.`, tone: 'text-port-success' };
  const parts = [errors ? plural(errors, 'problem') : null, warnings ? `${formatCount(warnings)} to improve` : null].filter(Boolean);
  return { text: `${parts.join(', ')}.`, tone: errors ? 'text-port-error' : 'text-port-warning' };
}

/**
 * The overlay text quality pass on the storyboard approval: a one-line verdict,
 * the findings (each with its time, which plays the preview there), and a
 * button to run it again. Advice like the camera notes: it never blocks approval.
 */
export default function OverlayTextCheck({ report, onCheck, busy = false, onSeek = null }) {
  if (!report) return null;
  const running = report.status === 'running';
  const stale = report.status === 'complete' && !report.current;
  const summary = summaryOf(report);
  const renderFinding = (finding) => {
    // A problem traced to a few frames shows its exact first frame and its length, so it isn't mistaken for a false alarm.
    const momentary = finding.span && !finding.span.open && finding.span.frames > 0;
    const time = formatTimecode(finding.atSec, momentary ? 3 : 2);
    return (
      <li key={finding.id} className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2">
          <span className={`font-medium ${finding.severity === 'error' ? 'text-port-error' : 'text-port-warning'}`}>{KIND_LABELS[finding.kind] || finding.kind}</span>
          {onSeek
            ? <button type="button" onClick={() => onSeek(finding.atSec)} aria-label={`Play ${time} in the preview`}
              className="min-h-[44px] text-port-accent underline sm:min-h-0">{time}</button>
            : <span>{time}</span>}
          {momentary && <span className="text-xs text-port-warning">{plural(finding.span.frames, 'frame')} only</span>}
          {finding.sceneLabel && <span className="min-w-0 break-words text-xs text-port-text-muted">{finding.sceneLabel}</span>}
          {finding.count > 1 && <span className="text-xs text-port-text-muted">seen {formatCount(finding.count)} times</span>}
        </div>
        <p className="break-words text-xs text-port-text-muted">{finding.message}</p>
      </li>
    );
  };
  const shown = report.findings.slice(0, SHOWN);
  const folded = report.findings.slice(SHOWN);
  return (
    <div role="group" aria-label="Overlay text check" className="mt-2 min-w-0 rounded border border-port-border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 break-words">
          <strong>Overlay text</strong> · <span role="status" className={summary.tone}>{summary.text}</span>
          {stale && <span className="text-port-text-muted"> This was the earlier version; check again.</span>}
        </p>
        <button type="button" className={buttonClass} disabled={busy || running} onClick={onCheck}>
          {running ? 'Checking…' : report.status === 'none' ? 'Check overlay text' : 'Check again'}
        </button>
      </div>
      {shown.length > 0 && <ul aria-label="Overlay text findings" className={`mt-2 space-y-2 ${stale ? 'opacity-70' : ''}`}>{shown.map(renderFinding)}</ul>}
      {folded.length > 0 && (
        <details className="mt-1">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-xs text-port-accent sm:min-h-0">{formatCount(folded.length)} more</summary>
          <ul className={`mt-2 space-y-2 ${stale ? 'opacity-70' : ''}`}>{folded.map(renderFinding)}</ul>
        </details>
      )}
      <p className="mt-1 text-xs text-port-text-muted">Looks at every lyric and shot for text that collides, runs off the frame, blends into the picture or is too small on a phone. It doesn&apos;t block approval.</p>
    </div>
  );
}
