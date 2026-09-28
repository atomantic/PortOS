import { useState } from 'react';
import { CheckCircle2, XCircle, RotateCcw } from 'lucide-react';

const STATUS_STYLES = {
  proposed: 'bg-port-border text-port-text',
  passed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};
const KIND_LABELS = { 'risk-shot': 'Highest-risk shot', 'transition-text': 'Transition / text sequence' };

// The artifacts a review can cite: the final render, then each proof scene's
// clips and frames (the server re-checks every citation).
function evidenceOptions(project, proof) {
  const options = [];
  if (project.renderHistoryId) options.push({ value: `video:${project.renderHistoryId}`, label: 'Final render' });
  for (const scene of project.scenes || []) {
    if (!proof.sceneIds.includes(scene.sceneId)) continue;
    const name = scene.label || scene.sectionLabel || 'Scene';
    const takes = Array.isArray(scene.takes) ? scene.takes : [];
    takes.filter((t) => t.kind === 'video').forEach((t, i) => options.push({ value: `video:${t.assetId}`, label: `${name} — clip ${i + 1}` }));
    takes.filter((t) => t.kind === 'image').forEach((t, i) => options.push({ value: `image:${t.assetId}`, label: `${name} — frame ${i + 1}` }));
  }
  return [...new Map(options.map((o) => [o.value, o])).values()];
}

function ProofRow({ project, proof, onReview }) {
  const options = evidenceOptions(project, proof);
  const [evidence, setEvidence] = useState(options[0]?.value || '');
  const [note, setNote] = useState('');
  const idFor = (suffix) => `mv-proof-${project.id}-${proof.id}-${suffix}`;
  const scenes = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const submit = (status) => {
    const [kind, id] = evidence ? [evidence.slice(0, evidence.indexOf(':')), evidence.slice(evidence.indexOf(':') + 1)] : [];
    onReview(proof.id, {
      status,
      ...(status === 'proposed' ? {} : {
        evidence: {
          ...(kind === 'video' ? { videoHistoryId: id } : {}),
          ...(kind === 'image' ? { imageId: id } : {}),
          note: note.trim(),
        },
      }),
    });
  };
  return (
    <li className="rounded border border-port-border/60 p-2 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${STATUS_STYLES[proof.status] || ''}`}>{proof.status}</span>
        <span className="font-medium">{KIND_LABELS[proof.kind] || proof.kind}</span>
        <span className="text-port-text-muted">{proof.sceneIds.map((id) => scenes.get(id)?.label || 'deleted scene').join(' → ')}</span>
      </div>
      <p>{proof.artifact}</p>
      {proof.risk && <p className="text-port-text-muted">Risk: {proof.risk}</p>}
      {proof.route && <p className="text-port-text-muted">Route: {proof.route}</p>}
      <ul className="list-disc pl-4 space-y-0.5">
        {proof.checks.map((check, i) => <li key={check}><strong>{check}</strong>: {proof.passCriteria[i]}</li>)}
      </ul>
      {proof.evidence?.note && <p className="text-port-text-muted">Reviewed: {proof.evidence.note}</p>}
      <div className="flex flex-wrap items-end gap-2 pt-1">
        <div className="min-w-0 basis-48 flex-1">
          <label htmlFor={idFor('evidence')} className="block text-[10px] text-port-text-muted">Evidence</label>
          <select id={idFor('evidence')} value={evidence} onChange={(e) => setEvidence(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs">
            <option value="">No artifact yet</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="min-w-0 basis-48 flex-[2]">
          <label htmlFor={idFor('note')} className="block text-[10px] text-port-text-muted">What you checked</label>
          <input id={idFor('note')} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. text readable at phone size, cut on the downbeat"
            className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        </div>
        <button type="button" onClick={() => submit('passed')} disabled={!evidence || !note.trim()}
          className="flex items-center gap-1 bg-port-success/20 text-port-success disabled:opacity-50 rounded px-2 py-1 min-h-[44px] sm:min-h-0">
          <CheckCircle2 size={12} /> Passed
        </button>
        <button type="button" onClick={() => submit('failed')} disabled={!note.trim()}
          className="flex items-center gap-1 bg-port-error/20 text-port-error disabled:opacity-50 rounded px-2 py-1 min-h-[44px] sm:min-h-0">
          <XCircle size={12} /> Failed
        </button>
        {proof.status !== 'proposed' && (
          <button type="button" onClick={() => submit('proposed')} aria-label="Reset proof to proposed" title="Reset to proposed"
            className="flex items-center gap-1 bg-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0">
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The proof checklist (#8980): the riskiest shot and one short transition/text
 * sequence to prove before full production. An entry stays `proposed` until a
 * review cites a real artifact; the server refuses a pass the artifact can't
 * show (a still for motion, anything but the final render for audio alignment
 * or composited text). Reviews are advisory — nothing else waits on them.
 */
export default function TreatmentProofs({ project, treatment, onReview }) {
  if (treatment.proofs.length === 0) return null;
  return (
    <div className="space-y-1">
      <span className="text-xs text-port-text-muted">Proof before full production</span>
      <ul className="space-y-2">
        {treatment.proofs.map((proof) => <ProofRow key={proof.id} project={project} proof={proof} onReview={onReview} />)}
      </ul>
    </div>
  );
}
