import { useEffect, useMemo, useState } from 'react';
import { Check, Film, Lock, RefreshCw, Wind } from 'lucide-react';
import toast from '../ui/Toast';
import { approveSpriteAmbient, lockSpriteReference } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import {
  CorrectionNoteToggle, AMBIENT_REFERENCE_CORRECTION_KEY, AMBIENT_LOOP_CORRECTION_KEY,
} from './CorrectionNote.jsx';
import { checkerboardStyle, spriteAssetUrl } from './spriteAssets.js';

// Places and objects have one identity root and one atlas row. Keeping this as
// a compact, dedicated surface prevents the character turnaround/8-direction
// affordances from leaking into a track that has neither concept.
export default function AmbientWorkflow({
  record, reference, ambient, renders, hasBackend, mode, onGenerateReference, onGenerateAmbient, onChanged,
  corrections = null, onCorrectionChange = null,
}) {
  const [designPrompt, setDesignPrompt] = useState('');
  const main = reference?.manifest?.mainReference || null;
  const candidate = useMemo(
    () => (reference?.candidates || []).find((item) => item.target === 'main') || null,
    [reference?.candidates],
  );
  const run = ambient?.runs?.[0] || null;
  const finalized = Boolean(ambient?.ambientSet);
  const referenceBusy = Boolean(renders?.pendingJobs?.main);
  const ambientBusy = ['rendering', 'postprocessing'].includes(run?.status);

  useEffect(() => {
    if (!ambientBusy) return undefined;
    const timer = setInterval(onChanged, 4000);
    return () => clearInterval(timer);
  }, [ambientBusy, onChanged]);

  const [lock, locking] = useAsyncAction(async () => {
    await lockSpriteReference(record.id, { target: 'main', candidate: candidate.path }, { silent: true });
    toast.success('Ambient reference frozen');
    onChanged();
  }, { errorMessage: 'Could not freeze the ambient reference' });

  const [approve, approving] = useAsyncAction(async () => {
    await approveSpriteAmbient(record.id, { runId: run.id }, { silent: true });
    toast.success('Ambient loop approved');
    onChanged();
  }, { errorMessage: 'Ambient approval failed' });

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white"><Wind className="w-4 h-4" /> Ambient Loop</h3>
        <span className="text-[11px] text-gray-500">one at-rest reference · one atlas row</span>
      </div>
      {!main?.locked ? (
        <div className="space-y-2">
          <label htmlFor={`ambient-design-${record.id}`} className="block text-xs text-gray-400">Describe this {record.kind}</label>
          <textarea
            id={`ambient-design-${record.id}`}
            value={designPrompt}
            onChange={(event) => setDesignPrompt(event.target.value)}
            placeholder="A willow tree with long branches moving gently in the wind"
            className="min-h-20 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
          />
          {candidate?.path && (
            <div className="flex items-center gap-2">
              <img className="h-20 w-20 rounded object-contain" style={checkerboardStyle(5)} src={spriteAssetUrl(record.id, candidate.path)} alt="Ambient reference candidate" />
              <button type="button" disabled={locking} onClick={lock} className="flex items-center gap-1 rounded bg-port-accent px-2 py-1.5 text-xs text-white disabled:opacity-50"><Lock className="w-3 h-3" /> Freeze reference</button>
            </div>
          )}
          {/* A correction is ADDITIVE (#3134) — it keeps the design above and
              fixes one thing about the last render, unlike editing the design
              prompt, which replaces the design outright. Only useful once there
              is a render to correct. */}
          {candidate && onCorrectionChange && (
            <CorrectionNoteToggle
              noteKey={AMBIENT_REFERENCE_CORRECTION_KEY}
              label="ambient reference"
              corrections={corrections}
              onChange={onCorrectionChange}
              placeholder="Correction (optional), e.g. the trunk leans too far right"
            />
          )}
          <button
            type="button"
            disabled={!hasBackend || !designPrompt.trim() || referenceBusy}
            onClick={() => onGenerateReference(designPrompt)}
            className="flex items-center gap-1 rounded border border-port-border px-2 py-1.5 text-xs text-gray-200 hover:border-port-accent disabled:opacity-50"
          >
            {referenceBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Film className="w-3 h-3" />}
            {candidate ? 'Regenerate reference' : 'Generate reference'}{mode ? '' : ' (select an image backend)'}
          </button>
        </div>
      ) : (
        <article className="rounded border border-port-border bg-port-bg p-2 space-y-2">
          <div className="flex items-center justify-between"><span className="text-xs font-medium text-white">Ambient row 0</span><span className={`text-[10px] ${finalized ? 'text-port-success' : ambientBusy ? 'text-port-accent' : 'text-gray-500'}`}>{finalized ? 'approved' : ambientBusy ? run.status : run?.status === 'candidate' ? 'review' : 'not generated'}</span></div>
          {run?.stripPreview?.stripPath ? (
            <img className="h-24 w-full rounded object-contain" style={checkerboardStyle(5)} src={spriteAssetUrl(record.id, run.stripPreview.stripPath, run.stripPreview.stripSha256)} alt="Ambient loop preview" />
          ) : <div className="h-24 grid place-items-center rounded text-gray-600" style={checkerboardStyle(5)}><Film className="w-4 h-4" /></div>}
          {!finalized && <div className="space-y-1.5">
            {onCorrectionChange && (
              <CorrectionNoteToggle
                noteKey={AMBIENT_LOOP_CORRECTION_KEY}
                label="ambient loop"
                corrections={corrections}
                onChange={onCorrectionChange}
                placeholder="Correction (optional), e.g. the branches barely move"
              />
            )}
            <div className="flex gap-1.5">
              <button type="button" disabled={ambientBusy} onClick={onGenerateAmbient} className="flex-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:border-port-accent disabled:opacity-50">{ambientBusy ? 'Rendering…' : run?.status === 'error' ? 'Retry' : 'Generate loop'}</button>
              {run?.status === 'candidate' && <button type="button" disabled={approving} aria-label="Approve ambient loop" onClick={approve} className="rounded bg-port-accent px-2 py-1 text-xs text-white disabled:opacity-50"><Check className="w-3 h-3" /></button>}
            </div>
          </div>}
          {run?.postprocessError && <p className="text-[10px] text-red-300">{run.postprocessError}</p>}
        </article>
      )}
    </section>
  );
}
