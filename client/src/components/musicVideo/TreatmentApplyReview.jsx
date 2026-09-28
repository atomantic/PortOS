import { useState } from 'react';
import { ClipboardCheck, AlertTriangle } from 'lucide-react';

const PROMPT_LABELS = {
  fill: 'prompts filled from the treatment',
  replace: 'treatment prompts updated',
  unchanged: 'prompts already match',
  manual: 'your edited prompts are kept',
  none: 'prompts untouched',
};

const snippet = (text) => (text && text.length > 90 ? `${text.slice(0, 89)}…` : text || '—');

/**
 * Apply review (#8980): shows exactly what applying the treatment would change
 * — per scene, whether its direction changes and what happens to its prompts —
 * before anything is written. Hand-edited prompts are kept unless the director
 * ticks "Use the treatment's prompts" for that scene; the server only honors
 * that tick for the exact prompts shown here. Selected takes are never touched.
 */
export default function TreatmentApplyReview({ project, api }) {
  const { preview, previewing, applying } = api;
  const [overwrite, setOverwrite] = useState({});
  const [addTextCues, setAddTextCues] = useState(false);
  const labels = new Map((project.scenes || []).map((s) => [s.sceneId, s.label || s.sectionLabel || 'Scene']));
  const idFor = (suffix) => `mv-apply-${project.id}-${suffix}`;

  const open = () => { setOverwrite({}); setAddTextCues(false); api.loadPreview(); };
  const changing = preview ? preview.scenes.filter((s) => s.directionChanged || ['fill', 'replace'].includes(s.prompt)).length : 0;
  const manual = preview ? preview.scenes.filter((s) => s.prompt === 'manual') : [];
  const hardStale = preview?.stale.filter((s) => s.blocking) || [];
  const audioStale = hardStale.some((s) => s.input === 'audio');

  const submit = () => api.apply({
    overwrite: manual.filter((s) => overwrite[s.sceneId]).map((s) => ({ sceneId: s.sceneId, promptFingerprint: s.promptFingerprint })),
    addTextCues,
  });

  return (
    <div className="space-y-2 border-t border-port-border pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={open} disabled={previewing || applying}
          className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
          <ClipboardCheck size={13} /> {previewing ? 'Reviewing…' : 'Review changes before applying'}
        </button>
        {preview && <span className="text-xs text-port-text-muted">{changing} of {preview.scenes.length} scenes would change</span>}
      </div>

      {preview && (
        <div className="space-y-2 rounded border border-port-border p-2 text-xs">
          {preview.stale.length > 0 && (
            <ul className="space-y-1">
              {preview.stale.map((s) => (
                <li key={s.input} className={`flex items-start gap-1.5 ${s.blocking ? 'text-port-error' : 'text-port-warning'}`}>
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {s.message}
                </li>
              ))}
            </ul>
          )}
          {hardStale.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span>Apply is blocked until the treatment matches the current project.</span>
              {!audioStale && (
                <button type="button" onClick={() => api.save({ rebase: true }).then(() => api.loadPreview())}
                  className="bg-port-border hover:bg-port-border/70 rounded px-2 py-1 min-h-[44px] sm:min-h-0">
                  Keep this treatment for the current inputs
                </button>
              )}
              {audioStale && <span className="text-port-text-muted">Recompile the treatment for the new song.</span>}
            </div>
          )}
          {hardStale.length === 0 && preview.unmappedSceneIds.length > 0 && (
            <p className="text-port-text-muted">{preview.unmappedSceneIds.length} newer scene{preview.unmappedSceneIds.length === 1 ? ' has' : 's have'} no direction — recompile to direct them.</p>
          )}
          <ul className="space-y-1 max-h-72 overflow-y-auto">
            {preview.scenes.map((s) => (
              <li key={s.sceneId} className="rounded border border-port-border/60 p-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{labels.get(s.sceneId) || s.label}</span>
                  <span className="text-port-text-muted">{s.directionChanged ? 'direction updated' : 'direction unchanged'} · {PROMPT_LABELS[s.prompt]}</span>
                  {s.keepsSelection && <span className="text-port-text-muted">· selected takes kept</span>}
                </div>
                {s.prompt === 'manual' && (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-port-text-muted">Yours: {snippet(s.current.framePrompt || s.current.prompt)}</p>
                    <p className="text-port-text-muted">Treatment: {snippet(s.suggested.framePrompt || s.suggested.prompt)}</p>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={!!overwrite[s.sceneId]}
                        onChange={(e) => setOverwrite((prev) => ({ ...prev, [s.sceneId]: e.target.checked }))} />
                      Use the treatment&apos;s prompts for this scene
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {preview.textCueCandidates > 0 && (
            <label htmlFor={idFor('cues')} className="flex items-center gap-1.5">
              <input id={idFor('cues')} type="checkbox" checked={addTextCues} onChange={(e) => setAddTextCues(e.target.checked)} />
              Add {preview.textCueCandidates} text cue{preview.textCueCandidates === 1 ? '' : 's'} from the timed lyrics, placed in each shot&apos;s reserved region
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={submit} disabled={preview.blocked || applying}
              className="bg-port-accent text-white disabled:opacity-50 rounded px-3 py-1.5 min-h-[44px] sm:min-h-0">
              {applying ? 'Applying…' : 'Apply treatment'}
            </button>
            <button type="button" onClick={api.clearPreview} className="text-port-text-muted underline">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
