import { useMemo } from 'react';
import { Check, Film, Radio, RefreshCw, Wind } from 'lucide-react';
import toast from '../ui/Toast';
import { approveSpriteTrack, reopenSpriteTrack } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { useAutoRefetch } from '../../hooks/useAutoRefetch.js';
import { SPRITE_DIRECTIONS } from '../../lib/spriteFacets.js';
import { CorrectionNoteToggle, trackCorrectionKey } from './CorrectionNote.jsx';
import { checkerboardStyle, spriteAssetUrl } from './spriteAssets.js';
import AnimationProviderPicker from './AnimationProviderPicker.jsx';

/**
 * One review/approve surface for EVERY non-walk animation track (#3136).
 *
 * Replaces `ScannerWorkflow.jsx` and the loop half of `AmbientWorkflow.jsx`,
 * which were the same grid of candidate cards with different copy hardcoded in.
 * Everything track-specific is read from the server's `definition` (the registry
 * row): the heading label, the frame/fps summary, whether there are eight facing
 * cards or one, and the approval count. So a user-defined track renders here with
 * no client change — which is the whole point of the epic, and the reason this
 * component must never grow an `if (track === …)`.
 *
 * Deliberately compact: a named action or an environment loop is not a second
 * walk editor. The server owns each track's defaults and validates its own range;
 * this exposes the direct user action, the candidate strip, and approval.
 *
 * `AmbientWorkflow.jsx` still owns the *reference* half for a place/object (the
 * design prompt + freeze step), which is a reference-set concern rather than an
 * animation-track one.
 */
export default function TrackWorkflow({
  record, reference, state, onGenerate, onChanged, corrections = null, onCorrectionChange = null,
  providers = null, provider = 'grok', onProviderChange = () => {},
}) {
  const definition = state?.definition || null;
  const runs = state?.runs || [];
  const selection = state?.selection || null;
  const finalized = Boolean(state?.set);
  const directional = Boolean(definition?.directional);
  // A directional track fills one card per facing; a non-directional one is the
  // single row 0. Derived from the row, not from the track's id.
  const directions = useMemo(
    () => (directional ? SPRITE_DIRECTIONS : [SPRITE_DIRECTIONS[0]]),
    [directional],
  );
  const latestByDirection = useMemo(() => Object.fromEntries(directions.map((direction) => [
    direction,
    runs.find((run) => run.direction === direction),
  ])), [runs, directions]);
  const working = runs.some((run) => ['rendering', 'postprocessing'].includes(run.status));

  useAutoRefetch(onChanged, 4000, { enabled: working, immediate: false, pollOnly: true });

  const [approve, approving] = useAsyncAction(async (direction, runId) => {
    await approveSpriteTrack(record.id, definition.id, { direction, runId }, { silent: true });
    toast.success(`${definition.label} ${directional ? `${direction} ` : ''}approved`);
    onChanged();
  }, { errorMessage: `${definition?.label || 'Track'} approval failed` });
  const [reopen, reopening] = useAsyncAction(async (direction) => {
    await reopenSpriteTrack(
      record.id,
      definition.id,
      directional ? { direction } : {},
      { silent: true },
    );
    toast.success(`${definition.label} reopened for a replacement render`);
    onChanged();
  }, { errorMessage: `${definition?.label || 'Track'} reopen failed` });

  // A track can only render from a locked reference, so the surface stays hidden
  // until one exists — otherwise it offers a Generate that always 409s. The main
  // lock is the right gate for BOTH source shapes: it's the direct source for a
  // non-directional track, and on a directional one it's the first thing the
  // turnaround-first flow freezes, so per-facing anchor readiness is the card's
  // problem (the server 409s that facing by name), not this section's.
  if (!definition || !reference?.manifest?.mainReference?.locked) return null;
  const approvedCount = Object.values(selection?.directions || {})
    .filter((entry) => entry?.status === 'approved').length;
  const Icon = directional ? Radio : Wind;

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Icon className="w-4 h-4" /> {definition.label}
          <span className="text-xs font-normal text-gray-500">
            {finalized ? 'finalized' : `${approvedCount}/${directions.length} approved`}
            {' · '}{definition.defaultFrameCount}f @ {definition.defaultFps}fps
          </span>
        </h3>
        {/* The lane caption is derived, not hardcoded (#4876): it read
            "directly requested Grok render" while grok was the only engine, and
            would have been a lie the moment a local render was picked. Only the
            packing half is unconditional — that is deterministic either way. */}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <AnimationProviderPicker
            id={`track-provider-${record.id}-${definition.id}`}
            providers={providers}
            provider={provider}
            onChange={onProviderChange}
            disabled={finalized}
          />
          <span className="text-[11px] text-gray-500">
            directly requested {provider === 'local' ? 'local' : 'Grok'} render; local deterministic packing
          </span>
        </div>
      </div>
      <div className={`grid gap-2 ${directional ? 'sm:grid-cols-2 xl:grid-cols-4' : ''}`}>
        {directions.map((direction) => {
          const run = latestByDirection[direction];
          const approved = selection?.directions?.[direction]?.status === 'approved';
          const busy = ['rendering', 'postprocessing'].includes(run?.status);
          const candidate = run?.status === 'candidate';
          const preview = run?.stripPreview;
          const cardLabel = directional ? direction : `${definition.label} row 0`;
          // The shared page-owned corrections map's key for THIS card (#3134,
          // generalized per track+facing in #3136).
          const correctionKey = trackCorrectionKey(definition.id, direction);
          return (
            <article key={direction} className="rounded border border-port-border bg-port-bg p-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-white">{cardLabel}</span>
                <span className={`text-[10px] ${approved ? 'text-port-success' : busy ? 'text-port-accent' : 'text-gray-500'}`}>
                  {approved ? 'approved' : busy ? run.status : candidate ? 'review' : 'not generated'}
                </span>
              </div>
              {preview?.stripPath ? (
                <img
                  className="h-20 w-full rounded object-contain"
                  style={checkerboardStyle(5)}
                  src={spriteAssetUrl(record.id, preview.stripPath, preview.stripSha256)}
                  alt={`${cardLabel} ${definition.label} preview`}
                />
              ) : (
                <div className="h-20 rounded text-xs text-gray-600 grid place-items-center" style={checkerboardStyle(5)}>
                  <Film className="w-4 h-4" />
                </div>
              )}
              {!finalized && !approved && (
                <div className="space-y-1.5">
                  {/* Optional correction the next render carries (#3134) — same
                      shared page-owned map every other re-roll surface writes,
                      keyed per track+facing (#3136). */}
                  {onCorrectionChange && (
                    <CorrectionNoteToggle
                      noteKey={correctionKey}
                      label={`${cardLabel} ${definition.label.toLowerCase()}`}
                      corrections={corrections}
                      onChange={onCorrectionChange}
                      placeholder="Correction (optional), e.g. the motion never returns to the start pose"
                    />
                  )}
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      // Both the request `direction` (only a directional track
                      // sends one — a single-row track's facing is derived
                      // server-side) and the note key are decided HERE, where the
                      // definition and the facing already are, so the page's
                      // handler needs no per-track lookup and stays stable across
                      // the 4s poll that replaces `detail` wholesale.
                      onClick={() => onGenerate(definition.id, {
                        direction: directional ? direction : undefined,
                        correctionKey,
                      })}
                      className="flex-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:border-port-accent disabled:opacity-50"
                    >
                      {busy ? <RefreshCw className="mx-auto w-3 h-3 animate-spin" /> : run?.status === 'error' ? 'Retry' : 'Generate'}
                    </button>
                    {candidate && (
                      <button
                        type="button"
                        disabled={approving}
                        aria-label={`Approve ${definition.label} ${cardLabel}`}
                        onClick={() => approve(direction, run.id)}
                        className="rounded bg-port-accent px-2 py-1 text-xs text-white disabled:opacity-50"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              )}
              {finalized && approved && (
                <button
                  type="button"
                  disabled={reopening}
                  onClick={() => reopen(direction)}
                  className="w-full rounded border border-port-warning/50 px-2 py-1 text-xs text-port-warning hover:border-port-warning disabled:opacity-50"
                >
                  {reopening ? 'Reopening…' : 'Reopen for replacement'}
                </button>
              )}
              {run?.postprocessError && <p className="text-[10px] text-red-300">{run.postprocessError}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
