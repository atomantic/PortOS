/**
 * Spoken-text check chip (#10250). Shows whether a rendered voice line, played
 * back through speech-to-text, matched its script: matched / heard "…" /
 * unverified. A mismatch warns only — the user may prefer the read — and can
 * offer Re-render and "Accept as spoken" (records what was heard as expected).
 */
import { Check, AlertTriangle, HelpCircle } from 'lucide-react';

export const countLinesNeedingListen = (items) =>
  (Array.isArray(items) ? items : []).filter((item) => item?.verification?.status === 'mismatch').length;

export default function SpokenCheckChip({ verification, onRerender, onAccept, busy = false }) {
  if (!verification?.status) return null;
  const { status, heard } = verification;
  if (status === 'matched') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-port-success" title="Speech-to-text heard the script">
        <Check size={11} /> matched
      </span>
    );
  }
  if (status === 'unverified') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-gray-500" title="Speech-to-text was not available, so this line was not checked">
        <HelpCircle size={11} /> unverified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 flex-wrap text-[11px] text-port-warning">
      <span className="inline-flex items-center gap-1" title="Speech-to-text heard something different from the script">
        <AlertTriangle size={11} /> heard &ldquo;{heard || '(nothing)'}&rdquo;
      </span>
      {onRerender ? (
        <button type="button" onClick={onRerender} disabled={busy} className="underline hover:text-white disabled:opacity-50">
          Re-render
        </button>
      ) : null}
      {onAccept && heard ? (
        <button type="button" onClick={onAccept} disabled={busy} className="underline hover:text-white disabled:opacity-50">
          Accept as spoken
        </button>
      ) : null}
    </span>
  );
}
