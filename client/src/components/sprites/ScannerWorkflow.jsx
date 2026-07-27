import { useEffect, useMemo } from 'react';
import { Check, Film, Radio, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import { approveSpriteScanner } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { SPRITE_DIRECTIONS } from '../../lib/spriteFacets.js';
import { CorrectionNoteToggle, scannerCorrectionKey } from './CorrectionNote.jsx';
import { checkerboardStyle, spriteAssetUrl } from './spriteAssets.js';

// Scanner is intentionally compact: it is a named action track, not a second
// walk editor. The server owns the 4-frame / 6fps default and validates its
// track-specific range; this UI exposes the direct user action, candidate review
// strip, and per-direction approval that freezes its atlas input.
export default function ScannerWorkflow({
  record, reference, scanner, onGenerate, onChanged, corrections = null, onCorrectionChange = null,
}) {
  const runs = scanner?.runs || [];
  const selection = scanner?.selection || null;
  const finalized = Boolean(scanner?.scannerSet);
  const renderable = Boolean(reference?.manifest?.mainReference?.locked);
  const latestByDirection = useMemo(() => Object.fromEntries(SPRITE_DIRECTIONS.map((direction) => [
    direction,
    runs.find((run) => run.direction === direction),
  ])), [runs]);
  const working = runs.some((run) => ['rendering', 'postprocessing'].includes(run.status));

  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(onChanged, 4000);
    return () => clearInterval(timer);
  }, [working, onChanged]);

  const [approve, approving] = useAsyncAction(async (direction, runId) => {
    await approveSpriteScanner(record.id, { direction, runId }, { silent: true });
    toast.success(`Scanner ${direction} approved`);
    onChanged();
  }, { errorMessage: 'Scanner approval failed' });

  if (!renderable) return null;
  const approvedCount = Object.values(selection?.directions || {})
    .filter((entry) => entry?.status === 'approved').length;

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Radio className="w-4 h-4" /> Scanner Action
          <span className="text-xs font-normal text-gray-500">{finalized ? 'finalized' : `${approvedCount}/8 approved`} · 4f @ 6fps</span>
        </h3>
        <span className="text-[11px] text-gray-500">directly requested Grok render; local deterministic packing</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {SPRITE_DIRECTIONS.map((direction) => {
          const run = latestByDirection[direction];
          const approved = selection?.directions?.[direction]?.status === 'approved';
          const busy = ['rendering', 'postprocessing'].includes(run?.status);
          const candidate = run?.status === 'candidate';
          const preview = run?.stripPreview;
          return (
            <article key={direction} className="rounded border border-port-border bg-port-bg p-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-white">{direction}</span>
                <span className={`text-[10px] ${approved ? 'text-port-success' : busy ? 'text-port-accent' : 'text-gray-500'}`}>
                  {approved ? 'approved' : busy ? run.status : candidate ? 'review' : 'not generated'}
                </span>
              </div>
              {preview?.stripPath ? (
                <img
                  className="h-20 w-full rounded object-contain"
                  style={checkerboardStyle(5)}
                  src={spriteAssetUrl(record.id, preview.stripPath, preview.stripSha256)}
                  alt={`${direction} scanner action preview`}
                />
              ) : (
                <div className="h-20 rounded text-xs text-gray-600 grid place-items-center" style={checkerboardStyle(5)}>
                  <Film className="w-4 h-4" />
                </div>
              )}
              {!finalized && !approved && (
                <div className="space-y-1.5">
                  {/* Optional correction the next render carries (#3134) — same
                      shared page-owned map every other re-roll surface writes. */}
                  {onCorrectionChange && (
                    <CorrectionNoteToggle
                      noteKey={scannerCorrectionKey(direction)}
                      label={`${direction} scanner action`}
                      corrections={corrections}
                      onChange={onCorrectionChange}
                      placeholder="Correction (optional), e.g. the sweep never returns to the start pose"
                    />
                  )}
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onGenerate(direction)}
                      className="flex-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:border-port-accent disabled:opacity-50"
                    >
                      {busy ? <RefreshCw className="mx-auto w-3 h-3 animate-spin" /> : run?.status === 'error' ? 'Retry' : 'Generate'}
                    </button>
                    {candidate && (
                      <button
                        type="button"
                        disabled={approving}
                        aria-label={`Approve scanner ${direction}`}
                        onClick={() => approve(direction, run.id)}
                        className="rounded bg-port-accent px-2 py-1 text-xs text-white disabled:opacity-50"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              )}
              {run?.postprocessError && <p className="text-[10px] text-red-300">{run.postprocessError}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
