import { currentPlateEvidence, renderQualityAcknowledged } from '../../../../server/lib/musicVideo/musicVideoPlateEvidence.js';
import { Loader2 } from 'lucide-react';
import { takeControl, takeProvenance } from '../../lib/musicVideoTakes.js';

const VERDICT_TONE = { pass: 'bg-port-success/20 text-port-success', fail: 'bg-port-error/20 text-port-error', unverified: 'bg-port-warning/20 text-port-warning' };

export function SceneTakeVerdict({ take, verdict, verdictOpen, onToggle }) {
  if (!verdict) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-port-text-muted" title={take.originalName || take.prompt || takeProvenance(take)}>
      {verdict.issues.length ? (
        <button type="button" onClick={onToggle} aria-expanded={verdictOpen}
          className={`rounded px-1 pointer-coarse:min-h-11 ${VERDICT_TONE[verdict.tone]}`} title="Show what the check found">
          {verdict.label} ({verdict.issues.length})
        </button>
      ) : <span className={`rounded px-1 ${VERDICT_TONE[verdict.tone]}`} title="A vision check found it matches the shot">{verdict.label}</span>}
    </div>
  );
}

export function SceneTakeVerdictIssues({ verdict }) {
  return (
    <ul className="space-y-0.5 text-[10px] text-port-warning">
      {verdict.issues.map((check) => <li key={check.id} className="break-words">{check.note}</li>)}
    </ul>
  );
}

export default function SceneTakeWarnings({ scene, take, project, frameTake, isSelected, onReview, busy, saving }) {
  const savingAcknowledge = Boolean(take.takeId && saving?.has(takeControl.acknowledge(scene, take)));
  const savingConfirm = Boolean(take.takeId && saving?.has(takeControl.confirm(scene, take)));
  const savingAccept = Boolean(take.takeId && saving?.has(takeControl.acceptCharacters(scene, take)));
  return (
    <>
      {frameTake && currentPlateEvidence(scene, take, project)?.checks.filter((check) => check.id === 'render-quality' && check.status === 'fail').map((check) => (
        <div key={check.id} className="space-y-1 text-xs text-port-warning">
          <p className="break-words">Rendering defect: {check.note}</p>
          {renderQualityAcknowledged(scene, take, project) ? <p>Explicitly acknowledged for this image.</p> : onReview && take.takeId && (
            <button type="button" disabled={busy || savingAcknowledge} className="inline-flex min-h-11 items-center gap-1 rounded border border-port-warning px-2 py-1 disabled:opacity-50"
              onClick={() => onReview(take, { acknowledgeRenderQuality: { basis: take.plateEvidence.basis, note: check.note } })}>
              {savingAcknowledge && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {savingAcknowledge ? 'Saving…' : 'Acknowledge rendering defect'}
            </button>
          )}
        </div>
      ))}
      {frameTake && isSelected && take.dependencyState?.status === 'stale' && onReview && take.takeId && (
        <div className="space-y-1 text-xs text-port-warning">
          <p className="break-words">Made for an earlier version of this shot{take.dependencyState.reasons?.length ? `: ${take.dependencyState.reasons.join(' · ')}` : ''}</p>
          <button type="button" disabled={busy || savingConfirm} className="inline-flex min-h-11 items-center gap-1 rounded border border-port-warning px-2 py-1 disabled:opacity-50"
            title="Keep this picture: record that it matches the shot as it now reads, so the clips made from it can render"
            onClick={() => onReview(take, { confirmFrame: true })}>
            {savingConfirm && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {savingConfirm ? 'Saving…' : 'Still matches'}
          </button>
        </div>
      )}
      {/* #16473: advice only. The take stays usable; "Still matches" keeps it for these references. */}
      {isSelected && take.characterReferenceState && (
        <div className="space-y-1 text-xs text-port-warning" data-testid="older-character-reference">
          <p className="break-words">{take.characterReferenceState.reasons.join(' · ')}</p>
          {onReview && take.takeId && (
            <button type="button" disabled={busy || savingAccept} className="inline-flex min-h-11 items-center gap-1 rounded border border-port-warning px-2 py-1 disabled:opacity-50"
              title="Keep this take: record that it still matches the current character references. A later change to them warns again."
              onClick={() => onReview(take, { acceptCharacterReferences: { revision: take.characterReferenceState.revision } })}>
              {savingAccept && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {savingAccept ? 'Saving…' : 'Still matches'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
