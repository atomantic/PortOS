import { useState } from 'react';
import LlmRouteNote from './LlmRouteNote.jsx';
import { Sparkles, Wand2, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import useFieldDraft from '../../hooks/useFieldDraft.js';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { formatTimecode } from '../../utils/formatters.js';
import MediumPlanSummary from './MediumPlanSummary.jsx';
import TreatmentShotList from './TreatmentShotList.jsx';
import TreatmentProofs from './TreatmentProofs.jsx';
import TreatmentApplyReview from './TreatmentApplyReview.jsx';

const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '2.39:1'];
const ROLE_STYLES = {
  opening: 'bg-port-accent/30 text-port-accent',
  build: 'bg-port-border text-port-text',
  contrast: 'bg-port-warning/30 text-port-warning',
  payoff: 'bg-port-success/30 text-port-success',
  release: 'bg-port-border text-port-text-muted',
};
const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0';

// One brief text field: buffered locally, committed on blur as a per-field patch.
function BriefField({ id, label, value, onCommit, multiline = false, maxLength, placeholder }) {
  const draft = useFieldDraft(value, onCommit);
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-port-text-muted mb-1">{label}</label>
      <Tag id={id} value={draft.value} onChange={draft.onChange} onBlur={draft.onBlur}
        maxLength={maxLength} placeholder={placeholder} rows={multiline ? 2 : undefined} className={inputCls} />
    </div>
  );
}

function BeatObjective({ beat, idFor, onSave }) {
  const draft = useFieldDraft(beat.objective, (objective) => onSave({ beats: [{ id: beat.id, objective }] }));
  return (
    <>
      <label htmlFor={idFor(`beat-${beat.id}`)} className="sr-only">Objective for {beat.label}</label>
      <textarea id={idFor(`beat-${beat.id}`)} rows={2} maxLength={1000} value={draft.value}
        onChange={draft.onChange} onBlur={draft.onBlur} className={inputCls} />
    </>
  );
}

/** One-line state for the section header: revision, applied state and capability gaps. */
export function treatmentSummary(project) {
  const t = project.treatment;
  if (!t) return 'Not started';
  const parts = [`rev ${t.revision}`];
  if (t.arc) {
    parts.push(`${t.shotDirections.length} directed ${t.shotDirections.length === 1 ? 'shot' : 'shots'}`);
    parts.push(t.appliedRevision != null && t.appliedRevision === t.revision ? 'applied' : 'not applied');
  }
  const gaps = t.capabilityGaps?.length || 0;
  if (gaps) parts.push(`${gaps} capability ${gaps === 1 ? 'gap' : 'gaps'}`);
  return parts.join(' · ');
}

/**
 * The pre-production treatment (#8980): a structured brief, the compiled
 * whole-song arc (beats by section, motifs, balance), per-shot direction, the
 * proof checklist and the Apply review. Compiling is always an explicit click —
 * "Draft without AI" makes no provider call at all. Keyed by project id at the
 * call site so a field draft never carries across projects.
 *
 * `part` splits it by what each piece depends on: the brief (what the planner
 * reads) needs no scenes, while compile / arc / shot direction / Apply need
 * them. The Storyboard step renders both. Omit it to render both. The caller supplies
 * the collapsible section, so there is no fold of its own here.
 * `storyboardApproved` (from the server's readiness) warns that any treatment
 * edit will need the storyboard re-approved (#10141).
 */
export default function TreatmentPanel({ project, treatment: api, part = 'all', storyboardApproved = false }) {
  const showBrief = part !== 'direction';
  const showDirection = part !== 'brief';
  const hasScenes = (project.scenes || []).length > 0;
  const t = project.treatment || null;
  const brief = t?.brief || {};
  const arc = t?.arc || null;
  const idFor = (suffix) => `mv-treat-${project.id}-${suffix}`;
  const saveBrief = (patch) => api.save({ brief: patch });
  const [noteText, setNoteText] = useState('');
  const [noteUrl, setNoteUrl] = useState('');
  // Note edits send the whole list, built from the rendered one: hold further
  // add/remove until the previous save lands so neither can drop the other.
  const [notesSaving, setNotesSaving] = useState(false);
  const saveNotes = (referenceNotes) => {
    setNotesSaving(true);
    // Only the editable fields go back: source/addedAt are server-stamped provenance.
    const editable = referenceNotes.map(({ id, note, url }) => ({ ...(id ? { id } : {}), note, url }));
    return saveBrief({ referenceNotes: editable }).finally(() => setNotesSaving(false));
  };
  const notes = brief.referenceNotes || [];
  const urlValid = !noteUrl.trim() || /^https?:\/\/\S+$/i.test(noteUrl.trim());
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });
  const analyzed = !!project.audioAnalysis;

  const addNote = () => {
    if (notesSaving || (!noteText.trim() && !noteUrl.trim()) || !urlValid) return;
    // Keep the typed note until the save lands, so a failed save loses nothing.
    saveNotes([...notes, { note: noteText.trim(), url: noteUrl.trim() || null }]).then((saved) => {
      if (!saved) return;
      setNoteText('');
      setNoteUrl('');
    });
  };

  return (
    <div className="space-y-3">
      {storyboardApproved && (
        <p role="note" className="rounded border border-port-warning/40 bg-port-warning/5 p-2 text-xs text-port-warning">
          The storyboard is approved. Editing the treatment will need re-approval of the storyboard.
        </p>
      )}
      {showBrief && (
        <>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <BriefField id={idFor('audience')} label="Audience" value={brief.audience} maxLength={500}
            placeholder="Who this is for — e.g. late-night city pop fans" onCommit={(v) => saveBrief({ audience: v })} />
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <BriefField id={idFor('destination')} label="Destination" value={brief.destination} maxLength={200}
              placeholder="Where it plays — e.g. vertical shorts feed" onCommit={(v) => saveBrief({ destination: v })} />
            <div>
              <label htmlFor={idFor('aspect')} className="block text-xs text-port-text-muted mb-1">Aspect</label>
              <select id={idFor('aspect')} value={brief.aspectRatio || ''} className={inputCls}
                onChange={(e) => saveBrief({ aspectRatio: e.target.value || null })}>
                <option value="">Any</option>
                {ASPECT_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <BriefField id={idFor('emotion')} label="Desired emotion" value={brief.emotion} maxLength={500}
            placeholder="What the viewer should feel" onCommit={(v) => saveBrief({ emotion: v })} />
          <BriefField id={idFor('hook')} label="Opening hook objective" value={brief.hookObjective} maxLength={1000}
            placeholder="What the first seconds must achieve" onCommit={(v) => saveBrief({ hookObjective: v })} />
          <BriefField id={idFor('graphic-language')} label="Graphic language" value={brief.graphicLanguage} maxLength={1000} multiline
            placeholder="HUD, pictograms, counters, and card typography" onCommit={(v) => saveBrief({ graphicLanguage: v })} />
          <BriefField id={idFor('premise')} label="Narrative premise" value={brief.premise} maxLength={2000} multiline
            placeholder="A story, or a visual arc without a literal plot" onCommit={(v) => saveBrief({ premise: v })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <BriefField id={idFor('must')} label="Must have" value={brief.mustHave} maxLength={2000} multiline
              placeholder="Comma-separated aesthetics or motifs" onCommit={(v) => saveBrief({ mustHave: v })} />
            <BriefField id={idFor('avoid')} label="Avoid" value={brief.avoid} maxLength={2000} multiline
              placeholder="What must not appear" onCommit={(v) => saveBrief({ avoid: v })} />
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-xs text-port-text-muted">Reference notes (your own notes and links — never fetched)</span>
          {notes.length > 0 && (
            <ul className="space-y-1">
              {notes.map((n) => (
                <li key={n.id} className="flex items-start gap-2 text-xs">
                  <span className="min-w-0 flex-1 break-words">{n.note}{n.url && <span className="text-port-text-muted"> — {n.url}</span>}</span>
                  <button type="button" aria-label="Remove reference note" title="Remove reference note"
                    onClick={() => saveNotes(notes.filter((x) => x.id !== n.id))} disabled={notesSaving}
                    className="min-h-[32px] min-w-[32px] inline-flex items-center justify-center text-port-error">
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-48">
              <label htmlFor={idFor('note')} className="sr-only">Reference note</label>
              <input id={idFor('note')} value={noteText} maxLength={1000} onChange={(e) => setNoteText(e.target.value)}
                placeholder="Note — e.g. grainy 16mm, hand-drawn overlays" className={inputCls} />
            </div>
            <div className="min-w-0 flex-1 basis-48">
              <label htmlFor={idFor('url')} className="sr-only">Reference URL</label>
              <input id={idFor('url')} value={noteUrl} maxLength={2000} onChange={(e) => setNoteUrl(e.target.value)}
                placeholder="https://… (optional)" className={`${inputCls} ${urlValid ? '' : 'border-port-error'}`} />
            </div>
            <button type="button" onClick={addNote} disabled={notesSaving || (!noteText.trim() && !noteUrl.trim()) || !urlValid || notes.length >= 20}
              className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
              <Plus size={13} /> Add note
            </button>
          </div>
        </div>
        {part === 'brief' && (
          <p className="text-xs text-port-text-muted">
            The planner reads this brief when it plans shots.
          </p>
        )}
        </>
      )}

      {showDirection && !hasScenes && (
        <p className="text-sm text-port-text-muted">Plan the shots to direct them one by one.</p>
      )}

      {showDirection && hasScenes && (
        <>
        <div className="flex flex-wrap items-center gap-2">
          {providers.length > 0 && (
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              label="AI provider"
              disabled={api.compiling}
              modelDisabled={availableModels.length === 0}
              compact
              alwaysShowModel
              emptyProviderOption="Active provider (default)"
              emptyModelOption="Default model"
            />
          )}
          <button type="button" disabled={!analyzed || api.compiling}
            onClick={() => api.compile({ useAi: true, providerId: selectedProviderId, model: selectedModel })}
            className="flex items-center gap-1 bg-port-accent text-white disabled:opacity-50 rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
            <Sparkles size={13} /> {api.compiling ? 'Compiling…' : (arc ? 'Recompile with AI' : 'Compile with AI')}
          </button>
          <button type="button" disabled={!analyzed || api.compiling} onClick={() => api.compile({ useAi: false })}
            className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
            <Wand2 size={13} /> Draft without AI
          </button>
          {!analyzed && <span className="text-xs text-port-text-muted">Analyze the song first — the arc is built on its sections.</span>}
          {t?.compiledAt && (
            t.compiledWith?.source === 'ai'
              ? <LlmRouteNote route={project.automation?.routes?.treatment || t.compiledWith} prefix="Compiled with" />
              : <span className="text-[11px] text-port-text-muted">Compiled deterministically</span>
          )}
        </div>

        {arc && (
          <div className="space-y-3">
            {t.capabilityGaps.length > 0 && (
              <ul className="space-y-1 rounded border border-port-warning/40 bg-port-warning/10 p-2">
                {t.capabilityGaps.map((g) => (
                  <li key={g.id} className="flex items-start gap-1.5 text-xs">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-port-warning" />
                    <span><strong>{g.id}</strong>: {g.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {arc.rationale && <p className="text-xs">{arc.rationale}</p>}
            {arc.lyricInterpretation && <p className="text-xs text-port-text-muted">Lyrics: {arc.lyricInterpretation}</p>}
            <ol className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {arc.beats.map((beat) => (
                <li key={beat.id} className="rounded border border-port-border p-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${ROLE_STYLES[beat.role] || ''}`}>{beat.role}</span>
                    <span className="font-medium">{beat.label}</span>
                    {beat.startSec != null && <span className="text-port-text-muted">{formatTimecode(beat.startSec)}–{formatTimecode(beat.endSec)}</span>}
                  </div>
                  <BeatObjective beat={beat} idFor={idFor} onSave={api.save} />
                  {beat.rationale && <p className="text-[11px] text-port-text-muted">{beat.rationale}</p>}
                </li>
              ))}
            </ol>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-port-text-muted">Recurring motifs</span>
                <ul className="mt-1 space-y-1">
                  {arc.motifs.map((m) => (
                    <li key={m.id}><strong>{m.name}</strong>{m.description ? ` — ${m.description}` : ''}{m.evolution && <span className="block text-port-text-muted">{m.evolution}</span>}</li>
                  ))}
                  {arc.motifs.length === 0 && <li className="text-port-text-muted">None yet.</li>}
                </ul>
              </div>
              <div>
                <span className="text-port-text-muted">Balance</span>
                <p className="mt-1">Performance {arc.balance.performance}% · Cutaway {arc.balance.cutaway}% · Graphic {arc.balance.graphic}%</p>
                {arc.balance.rationale && <p className="text-port-text-muted">{arc.balance.rationale}</p>}
              </div>
            </div>
            <MediumPlanSummary project={project} />
            <TreatmentShotList project={project} treatment={t} onSave={api.save} />
            <TreatmentProofs project={project} treatment={t} onReview={api.reviewProof} />
            <TreatmentApplyReview project={project} api={api} />
          </div>
        )}
        </>
      )}
    </div>
  );
}
