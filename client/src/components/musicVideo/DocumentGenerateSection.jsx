import { compactButtonClass as buttonCls, inputXsClass as inputCls } from './controlClasses.js';
import { supportsToolFreeOneShot, toolFreeOneShotSelectionPolicy } from '../../utils/providerSelection.js';
import { musicVideoDocumentRenderer } from '../../../../server/lib/musicVideo/musicVideoMediaPolicy.js';
import { useEffect, useState } from 'react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { useTimeTick } from '../../hooks/useTimeTick.js';
import { Film, RotateCcw } from 'lucide-react';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';
import FilmStylePicker from '../codeAnimation/FilmStylePicker.jsx';
import NarrativeEventsEditor from './NarrativeEventsEditor.jsx';
import StageSection from './StageSection.jsx';
import { compositionDraft } from './compositionDraft.js';
import {
  generateMusicVideoMixedMediaDocument, regenerateMusicVideoMixedMediaSection,
  reviseMusicVideoMixedMediaEvents, updateMusicVideoProject,
  getMusicVideoMixedMediaCandidate, acceptMusicVideoMixedMediaDocument, discardMusicVideoMixedMediaDocument,
} from '../../services/apiMusicVideo.js';

/** Whole seconds since mount; mounted only while a generation runs, so it ticks only then. */
function ElapsedSeconds() {
  const [startedAt] = useState(() => Date.now());
  const now = useTimeTick(1000);
  return <>{Math.max(0, Math.floor((now - startedAt) / 1000))}s</>;
}

function useDocumentCandidate(project) {
  const [candidate, setCandidate] = useState(null);
  useEffect(() => {
    let active = true;
    if (!project.composition?.documentDraft && project.composition?.document?.source?.kind !== 'generated') {
      setCandidate(null); return () => { active = false; };
    }
    getMusicVideoMixedMediaCandidate(project.id, { silent: true })
      .then((next) => { if (active) setCandidate(next); })
      .catch((err) => { if (active) toast.error(err?.message || 'Could not load the candidate'); });
    return () => { active = false; };
  }, [project.id, project.updatedAt, project.composition?.documentDraft?.directory, project.composition?.document?.directory, project.composition?.document?.source?.kind]);
  return candidate;
}

function CandidateReview({ project, doc, audioUrl, busy, eventPending, candidate, selectedSection, run }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const accept = () => run('accept', () => acceptMusicVideoMixedMediaDocument(project.id, candidate?.candidate?.directory, { silent: true }), 'Candidate selected for rendering');
  const discard = () => run('discard', () => discardMusicVideoMixedMediaDocument(project.id, candidate?.candidate?.directory, { silent: true }), 'Candidate discarded');
  const compareSection = candidate?.sections?.find((section) => section.id === selectedSection);
  const comparisonSeek = compareSection ? { t: compareSection.startSec, n: compareSection.startSec + 1 } : null;
  return (
    <StageSection id="mv-doc-candidate" title="Candidate review" summary="Compare and accept or discard" defaultOpen>
      <div className="rounded border border-port-border p-2">
        <p className="mb-2 text-xs text-port-text-muted">Candidate preview · {candidate.providerId || 'provider'} / {candidate.model || 'default model'} · active document stays selected until accepted</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {doc?.source?.kind === 'generated' && <div><p className="text-xs text-port-text-muted">Before · accepted section</p><CompositionPreviewPlayer project={project} audioUrl={null} seekRequest={comparisonSeek} /></div>}
          <div><p className="text-xs text-port-text-muted">After · candidate section</p><CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={comparisonSeek} draft /></div>
        </div>
        {(candidate.comparisons || []).filter((entry) => !selectedSection || entry.sectionId === selectedSection).map((entry) => <p key={entry.sectionId} className="mt-2 text-xs text-port-text-muted">
          {entry.sectionId}: before {entry.before.map((event) => `${event.name} @ frame ${event.startFrame}`).join(', ') || 'no events'}; after {entry.after.map((event) => `${event.name} @ frame ${event.startFrame}`).join(', ') || 'no events'}
        </p>)}
      </div>
      <div className="flex gap-2">
        <button type="button" className={buttonCls} disabled={!!busy || eventPending || candidate.stale} onClick={accept}>Accept reviewed version</button>
        {confirmDiscard ? (
          <ConfirmButtonPair
            prompt="Discard candidate?"
            confirmText="Discard"
            ariaLabel="Confirm discard candidate"
            confirmAriaLabel="Confirm discard candidate"
            largeTouchTargets
            busy={!!busy}
            onConfirm={() => { setConfirmDiscard(false); discard(); }}
            onCancel={() => setConfirmDiscard(false)}
          />
        ) : (
          <button type="button" className={buttonCls} disabled={!!busy} onClick={() => setConfirmDiscard(true)}>Discard candidate</button>
        )}
      </div>
    </StageSection>
  );
}

function generationSummary(busy, candidate, providerName, model) {
  return busy === 'generate' || busy === 'regenerate'
    ? <>Generating… <ElapsedSeconds /> · {providerName || 'provider'} / {model || 'model'}</>
    : candidate
    ? `Ready to review`
    : 'Generate or regenerate section';
}

export default function DocumentGenerateSection({ project, doc, busy, run, audioUrl }) {
  const candidate = useDocumentCandidate(project);
  const [selectedSection, setSelectedSection] = useState('');
  const [eventPending, setEventPending] = useState(false);
  const {
    providers, selectedProviderId, selectedModel, availableModels, selectedProvider,
    setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ preselectDefaults: true, silent: true, filter: Boolean });

  // Cleared by omitting the key: the composition body is replaced whole.
  const setFilmStyle = (styleGrammarId) => {
    const { styleGrammarId: _previous, ...composition } = compositionDraft(project);
    return run('film-style', () => updateMusicVideoProject(project.id, { composition: styleGrammarId ? { ...composition, styleGrammarId } : composition }, { silent: true }).then((project) => ({ project })), 'Film style saved');
  };
  const effectiveModel = selectedModel || selectedProvider?.defaultModel || '';
  const authoringValid = supportsToolFreeOneShot(providers.find((entry) => entry.id === selectedProviderId)) && Boolean(selectedProviderId && effectiveModel);
  const provider = { providerId: selectedProviderId, model: effectiveModel };
  const selectedSectionValid = candidate?.sections?.some((section) => section.id === selectedSection) || false;
  const generate = () => run('generate', () => generateMusicVideoMixedMediaDocument(project.id, provider, { silent: true }), 'Candidate ready to review');
  const regenerate = () => selectedSectionValid && run('regenerate', () => regenerateMusicVideoMixedMediaSection(project.id, selectedSection,
    { ...provider, expectedDraft: candidate?.source?.directory }, { silent: true }), 'New candidate ready to review');
  const saveEvents = (events) => run('events', async () => ({ project: await updateMusicVideoProject(project.id,
    { composition: compositionDraft(project, events) }, { silent: true }) }), 'Event bindings saved');
  const reviseEvents = () => run('event-revision', () => reviseMusicVideoMixedMediaEvents(project.id,
    { ...provider, expectedDraft: candidate?.source?.directory }, { silent: true }), 'Affected sections revised; selected footage retained');
  const generateSummary = generationSummary(busy, candidate, selectedProvider?.name, effectiveModel);
  const authoringBlocked = Boolean(busy || eventPending || !authoringValid);
  return (
    <>
      <StageSection id="mv-doc-generate" title="Generate & revise" summary={generateSummary} defaultOpen={!candidate}>
        <NarrativeEventsEditor key={`${project.id}-${JSON.stringify([project.composition?.narrativeEvents, project.composition?.reactiveSections])}`}
          project={project} sections={candidate?.sections || []} disabled={!!busy} onSave={saveEvents} onPendingChange={setEventPending} />
        <FilmStylePicker id="mv-doc-film-style" value={project.composition?.styleGrammarId || ''} onChange={setFilmStyle} disabled={!!busy}
          labelClass="block text-xs text-port-text-muted mb-0.5" inputClass={`${inputCls} w-full`}
          hint="optional medium rulebook every section follows; the approved palette and lyric readability win" noneLabel="None (treatment only)" />
        <p className="text-xs text-port-text-muted">Generate from the approved treatment, song timing and selected project assets. Missing media is reported before any provider call.</p>
        {providers.length > 0 && <ProviderModelSelector
          providers={providers} selectedProviderId={selectedProviderId} selectedModel={selectedModel}
          availableModels={availableModels} onProviderChange={setSelectedProviderId} onModelChange={setSelectedModel}
          selectionPolicy={toolFreeOneShotSelectionPolicy} label="Mixed-media code provider" disabled={!!busy} modelDisabled={availableModels.length === 0}
          compact alwaysShowModel
        />}
        <p className="text-xs text-port-text-muted">Code authoring uses {selectedProvider?.name || selectedProviderId || 'no provider selected'} / {effectiveModel || 'no model selected'}. Nothing is sent until you click. API providers and server-verified tool-free CLIs can author; TUI sessions cannot.</p>
        {!authoringValid && <p className="text-xs text-port-warning" role="status">Choose a compatible code authoring provider and model before generation.</p>}
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={`${buttonCls} bg-port-accent text-white`} disabled={authoringBlocked} onClick={generate}>
            <Film size={14} /> {busy === 'generate' ? <>Generating… <ElapsedSeconds /></> : musicVideoDocumentRenderer(project) === 'three' ? 'Generate authored 3D composition' : 'Generate mixed-media composition'}
          </button>
          {candidate?.source && <>
            <div>
              <label htmlFor="mv-doc-section" className="block text-xs text-port-text-muted mb-0.5">Section to revise</label>
              <select id="mv-doc-section" className={inputCls} value={selectedSectionValid ? selectedSection : ''} onChange={(e) => setSelectedSection(e.target.value)}>
                <option value="">Choose section</option>
                {candidate.sections.map((section) => <option key={section.id} value={section.id}>{section.label || section.id} · {section.startSec}s</option>)}
              </select>
            </div>
            <button type="button" className={buttonCls} disabled={authoringBlocked || !selectedSectionValid || candidate.stale} onClick={regenerate}>
              <RotateCcw size={14} /> {busy === 'regenerate' ? <>Regenerating… <ElapsedSeconds /></> : 'Regenerate section'}
            </button>
            <button type="button" className={buttonCls} disabled={authoringBlocked || !candidate.eventRevisionAvailable} onClick={reviseEvents}>
              {busy === 'event-revision' ? 'Revising events…' : 'Revise events only'}
            </button>
          </>}
        </div>
        {candidate?.stale && <p className="text-xs text-port-warning" role="status">{candidate.eventRevisionAvailable ? 'Event bindings changed. Revise events only to retain selected footage.' : 'The treatment, song or selected assets changed. Generate a fresh candidate.'}</p>}
      </StageSection>

      {candidate?.candidate && <CandidateReview project={project} doc={doc} audioUrl={audioUrl} busy={busy} run={run}
        eventPending={eventPending} candidate={candidate} selectedSection={selectedSection} />}
    </>
  );
}
