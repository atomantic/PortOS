import { supportsToolFreeOneShot, toolFreeOneShotSelectionPolicy } from '../../utils/providerSelection.js';
import MediaModePicker from './MediaModePicker.jsx';
import { musicVideoMediaMode, musicVideoDocumentRenderer } from '../../../../server/lib/musicVideoMediaPolicy.js';
import { useEffect, useState, useRef } from 'react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { useTimeTick } from '../../hooks/useTimeTick.js';
import FilePickerButton from '../ui/FilePickerButton.jsx';
import { Download, FileArchive, FolderInput, LayoutTemplate, Unlink, Film, RotateCcw } from 'lucide-react';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';
import NarrativeEventsEditor from './NarrativeEventsEditor.jsx';
import StageSection from './StageSection.jsx';
import { downloadBlob } from '../../lib/downloadBlob';
import { formatBytes, timeAgo } from '../../utils/formatters.js';
import { compositionDraft } from './compositionDraft.js';
import {
  detachMusicVideoCompositionDocument, getMusicVideoCompositionDocument, getMusicVideoCompositionExport,
  importMusicVideoCompositionDirectory, importMusicVideoCompositionZip, startMusicVideoCompositionTemplate,
  generateMusicVideoMixedMediaDocument, regenerateMusicVideoMixedMediaSection,
  reviseMusicVideoMixedMediaEvents, updateMusicVideoProject,
  getMusicVideoMixedMediaCandidate, acceptMusicVideoMixedMediaDocument, discardMusicVideoMixedMediaDocument,
} from '../../services/apiMusicVideo.js';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';
const inputCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';
const SOURCE_LABELS = { template: 'template', zip: 'zip', directory: 'folder', generated: 'generated' };

const linesOf = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
// "12.5 = 80" per line → [[12.5, 80], …]; unparseable lines are dropped.
const keyframesOf = (value) => linesOf(value)
  .map((line) => line.split(/[=:,\s]+/).map(Number))
  .filter(([t, v]) => Number.isFinite(t) && t >= 0 && Number.isFinite(v) && v >= 0 && v <= 100)
  .map(([t, v]) => [t, v]);

/**
 * HUD block the layered template draws (`composition.overlay`). Text fields
 * edit locally and persist on blur, replacing the whole manifest.
 */
function OverlayEditor({ project, onSave }) {
  const composition = compositionDraft(project);
  const overlay = composition.overlay || null;
  const [draft, setDraft] = useState(() => ({
    titleLines: (overlay?.titleLines || []).join('\n'),
    ticker: (overlay?.ticker || []).join('\n'),
    meterLabel: overlay?.meter?.label || '',
    keyframes: (overlay?.meter?.keyframes || []).map(([t, v]) => `${t} = ${v}`).join('\n'),
  }));
  const save = (patch = {}) => {
    const next = {
      enabled: overlay?.enabled ?? true,
      timecode: overlay?.timecode ?? true,
      timecodeStartSec: overlay?.timecodeStartSec ?? 0,
      titleLines: linesOf(draft.titleLines).slice(0, 4),
      ticker: linesOf(draft.ticker).slice(0, 40),
      meter: draft.meterLabel || draft.keyframes ? { label: draft.meterLabel.trim().slice(0, 40), keyframes: keyframesOf(draft.keyframes) } : null,
      ...patch,
    };
    onSave({ composition: { ...composition, overlay: next } });
  };
  const field = (key) => ({ value: draft[key], onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })), onBlur: () => save() });
  return (
    <details className="rounded border border-port-border p-2 text-xs">
      <summary className="cursor-pointer select-none text-port-text-muted min-h-[44px] sm:min-h-0 flex items-center">HUD overlay — {overlay?.enabled === false || !overlay ? 'off' : 'on'} (drawn by the layered template)</summary>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label htmlFor="mv-doc-hud-on" className="flex items-center gap-1 min-h-[44px] sm:min-h-0">
          <input id="mv-doc-hud-on" type="checkbox" checked={Boolean(overlay) && overlay.enabled !== false} onChange={(e) => save({ enabled: e.target.checked })} /> Show HUD
        </label>
        <label htmlFor="mv-doc-hud-tc" className="flex items-center gap-1 min-h-[44px] sm:min-h-0">
          <input id="mv-doc-hud-tc" type="checkbox" checked={overlay?.timecode ?? true} onChange={(e) => save({ timecode: e.target.checked })} /> Timecode
        </label>
        <label htmlFor="mv-doc-hud-tc-start" className="flex items-center gap-1">
          Timecode starts at (s)
          <input id="mv-doc-hud-tc-start" type="number" min={0} step={1} className={`${inputCls} w-24`} defaultValue={overlay?.timecodeStartSec ?? 0}
            onBlur={(e) => save({ timecodeStartSec: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <div>
          <label htmlFor="mv-doc-hud-title" className="block text-port-text-muted mb-0.5">Title lines (up to 4)</label>
          <textarea id="mv-doc-hud-title" rows={3} className={`${inputCls} w-full`} {...field('titleLines')} />
        </div>
        <div>
          <label htmlFor="mv-doc-hud-ticker" className="block text-port-text-muted mb-0.5">Ticker (one item per line)</label>
          <textarea id="mv-doc-hud-ticker" rows={3} className={`${inputCls} w-full`} {...field('ticker')} />
        </div>
        <div>
          <label htmlFor="mv-doc-hud-meter" className="block text-port-text-muted mb-0.5">Meter label</label>
          <input id="mv-doc-hud-meter" type="text" maxLength={40} className={`${inputCls} w-full`} {...field('meterLabel')} />
        </div>
        <div>
          <label htmlFor="mv-doc-hud-keys" className="block text-port-text-muted mb-0.5">Meter keyframes (seconds = percent, one per line)</label>
          <textarea id="mv-doc-hud-keys" rows={3} placeholder={'0 = 100\n60 = 40'} className={`${inputCls} w-full`} {...field('keyframes')} />
        </div>
      </div>
    </details>
  );
}

/** The document's files, read when opened (the manifest route). */
function DocumentFiles({ projectId, directory }) {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  const load = (open) => {
    if (!open || manifest) return;
    getMusicVideoCompositionDocument(projectId, { silent: true })
      .then(setManifest)
      .catch((err) => setError(err?.message || 'Could not list the document files'));
  };
  return (
    <details key={directory} className="rounded border border-port-border p-2 text-xs" onToggle={(e) => load(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-port-text-muted min-h-[44px] sm:min-h-0 flex items-center">Files</summary>
      {error && <p role="status" className="mt-1 text-port-error">{error}</p>}
      {manifest && !manifest.available && <p className="mt-1 text-port-warning">The document folder is missing on this machine — import it again.</p>}
      {manifest?.available && (
        <ul className="mt-1 max-h-48 overflow-y-auto font-mono">
          {manifest.files.map((file) => <li key={file.path} className="flex justify-between gap-2"><span className="min-w-0 break-all">{file.path}</span><span className="shrink-0 text-port-text-muted">{formatBytes(file.bytes)}</span></li>)}
        </ul>
      )}
    </details>
  );
}


/** Whole seconds since mount; mounted only while a generation runs, so it ticks only then. */
function ElapsedSeconds() {
  const [startedAt] = useState(() => Date.now());
  const now = useTimeTick(1000);
  return <>{Math.max(0, Math.floor((now - startedAt) / 1000))}s</>;
}

/**
 * The project's composition document (render style `document`): what is
 * attached, import (template / zip / data folder), export, the HUD overlay and
 * the document's files. The live preview is `CompositionPreviewPlayer`, docked
 * beside the stage tabs so it stays visible while scenes and typography are
 * edited.
 */
export default function DocumentCompositionPanel({ project, audioUrl, onProject, onSave }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const doc = project.composition?.document || null;
  const [busy, setBusy] = useState(null);
  // Replacing or detaching drops the current version folder once nothing
  // points at it, so both ask for a second click (no window.confirm).
  const [confirming, setConfirming] = useState(null);
  const confirmTimerRef = useRef(null);
  const [folder, setFolder] = useState('');
  const [candidate, setCandidate] = useState(null);
  const [selectedSection, setSelectedSection] = useState('');
  const [eventPending, setEventPending] = useState(false);
  const {
    providers, selectedProviderId, selectedModel, availableModels, selectedProvider,
    setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ preselectDefaults: true, silent: true, filter: Boolean });

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

  // Clear confirm state after 5 seconds or when the panel loses focus
  useEffect(() => {
    if (!confirming) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      return;
    }
    confirmTimerRef.current = setTimeout(() => setConfirming(null), 5000);
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [confirming]);

  const run = async (label, task, success) => {
    setBusy(label);
    const result = await Promise.resolve().then(task).catch((err) => { toast.error(err?.message || 'Composition document action failed'); return null; });
    setBusy(null);
    if (result?.project) onProject(result.project);
    if (result && success) toast.success(success);
    return result;
  };
  const confirmFirst = (key, action) => () => {
    if (doc && confirming !== key) { setConfirming(key); return; }
    setConfirming(null);
    action();
  };
  const startTemplate = confirmFirst('template', () => run('template', () => startMusicVideoCompositionTemplate(project.id, 'layered', { silent: true }), 'Layered template copied into this project'));
  const importZip = (file) => file && run('zip', () => importMusicVideoCompositionZip(project.id, file, { silent: true }), 'Composition document imported');
  const importFolder = () => folder.trim() && run('folder', () => importMusicVideoCompositionDirectory(project.id, folder.trim(), { silent: true }), 'Composition document imported');
  const exportZip = () => run('export', async () => {
    const buffer = await getMusicVideoCompositionExport(project.id, { silent: true });
    downloadBlob(buffer, `${(project.name || 'music-video').replace(/[^\w.-]+/g, '-')}-composition.zip`, 'application/zip');
    return {};
  });
  const detach = confirmFirst('detach', () => run('detach', () => detachMusicVideoCompositionDocument(project.id, { silent: true }), 'Composition document detached'));
  const effectiveModel = selectedModel || selectedProvider?.defaultModel || '';
  const authoringValid = supportsToolFreeOneShot(providers.find((entry) => entry.id === selectedProviderId)) && Boolean(selectedProviderId && effectiveModel);
  const provider = { providerId: selectedProviderId, model: effectiveModel };
  const selectedSectionValid = candidate?.sections?.some((section) => section.id === selectedSection) || false;
  const generate = () => run('generate', () => generateMusicVideoMixedMediaDocument(project.id, provider, { silent: true }), 'Candidate ready to review');
  const regenerate = () => selectedSectionValid && run('regenerate', () => regenerateMusicVideoMixedMediaSection(project.id, selectedSection,
    { ...provider, expectedDraft: candidate?.source?.directory }, { silent: true }), 'New candidate ready to review');
  const accept = () => run('accept', () => acceptMusicVideoMixedMediaDocument(project.id, candidate?.candidate?.directory, { silent: true }), 'Candidate selected for rendering');
  const discard = () => run('discard', () => discardMusicVideoMixedMediaDocument(project.id, candidate?.candidate?.directory, { silent: true }), 'Candidate discarded');
  const saveEvents = (events) => run('events', async () => ({ project: await updateMusicVideoProject(project.id,
    { composition: compositionDraft(project, events) }, { silent: true }) }), 'Event bindings saved');
  const reviseEvents = () => run('event-revision', () => reviseMusicVideoMixedMediaEvents(project.id,
    { ...provider, expectedDraft: candidate?.source?.directory }, { silent: true }), 'Affected sections revised; selected footage retained');
  const compareSection = candidate?.sections?.find((section) => section.id === selectedSection);
  const comparisonSeek = compareSection ? { t: compareSection.startSec, n: compareSection.startSec + 1 } : null;

  const docSummary = doc ? `${SOURCE_LABELS[doc.source?.kind] || 'imported'}${doc.source?.name ? ` · ${doc.source.name}` : ''}` : 'None yet';
  const generateSummary = busy === 'generate' || busy === 'regenerate'
    ? <>Generating… <ElapsedSeconds /> · {selectedProvider?.name || 'provider'} / {effectiveModel || 'model'}</>
    : candidate
    ? `Ready to review`
    : 'Generate or regenerate section';

  return (
    <section className="mt-3 space-y-2 rounded-lg border border-port-border bg-port-bg p-2" aria-label="Composition document">
      <div className="flex items-center gap-2 text-sm text-port-text">
        <span>Composition document</span>
        {doc && <span className="text-xs text-port-text-muted">
          {doc.files != null && `${doc.files} files`}
          {doc.bytes != null && ` · ${formatBytes(doc.bytes)}`}
          {doc.updatedAt && ` · updated ${timeAgo(doc.updatedAt)}`}
        </span>}
      </div>

      <StageSection id="mv-doc-source" title="Document source" summary={docSummary}>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={buttonCls} disabled={!!busy} onClick={startTemplate}
            title="Copy PortOS's layered template (scene media, camera moves, grain, HUD, kinetic lyrics) into this project">
            <LayoutTemplate size={14} /> {busy === 'template' ? 'Copying…' : confirming === 'template' ? 'Click again to replace' : doc ? 'Replace with template' : 'Start from template'}
          </button>
          <FilePickerButton accept=".zip,application/zip" onChange={(e) => importZip(e.target.files?.[0])} disabled={!!busy}
            ariaLabel="Import zip composition document" className={`${buttonCls} cursor-pointer`}
            title="A .zip whose root (or single top folder) holds index.html">
            <FileArchive size={14} aria-hidden="true" /> {busy === 'zip' ? 'Importing…' : 'Import zip'}
          </FilePickerButton>
          <div className="flex items-end gap-1">
            <div>
              <label htmlFor="mv-doc-folder" className="block text-xs text-port-text-muted mb-0.5">Folder inside data/</label>
              <input id="mv-doc-folder" type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="compositions/my-video"
                className={`${inputCls} w-48`} />
            </div>
            <button type="button" className={buttonCls} disabled={!!busy || !folder.trim()} onClick={importFolder}>
              <FolderInput size={14} /> {busy === 'folder' ? 'Importing…' : 'Import folder'}
            </button>
          </div>
          <button type="button" className={buttonCls} disabled={!!busy || !doc} onClick={exportZip}>
            <Download size={14} /> Export zip
          </button>
          <button type="button" className={buttonCls} disabled={!!busy || !doc} onClick={detach} title="Stop using this document (the render refuses until another is attached)">
            <Unlink size={14} /> {confirming === 'detach' ? 'Click again to detach' : 'Detach'}
          </button>
        </div>
        <MediaModePicker value={musicVideoMediaMode(project)} disabled={!!busy} onChange={(mediaMode) => run('policy', () => updateMusicVideoProject(project.id, { mediaMode }, { silent: true }).then((project) => ({ project })), 'Media mode saved')} />
        <label htmlFor="mv-doc-renderer" className="block text-xs text-port-text-muted">Authoring renderer</label>
        <select id="mv-doc-renderer" disabled={!!busy} value={musicVideoDocumentRenderer(project)} className={inputCls}
          onChange={(event) => run('renderer', () => updateMusicVideoProject(project.id, { composition: { ...compositionDraft(project), authoringRenderer: event.target.value } }, { silent: true }).then((project) => ({ project })), 'Renderer saved')}>
          <option value="three">Three.js authored worlds</option><option value="canvas">Canvas layered scenes</option>
        </select>
        <p className="text-xs text-port-text-muted">Three.js: modeled geometry, lighting, articulated characters and camera, with a local font overlay. Generated Three.js worlds use geometry only; selected images/video require Canvas or an imported document. Preview and export share deterministic seek(t), 1080p at 24 fps by default. Native Code mode remains the limited 720p Canvas renderer. Local ES modules and fonts are packaged; remote imports are blocked. Document motion blur is honored on export.</p>
      </StageSection>

      <StageSection id="mv-doc-generate" title="Generate & revise" summary={generateSummary} defaultOpen={!candidate}>
        <NarrativeEventsEditor key={`${project.id}-${JSON.stringify([project.composition?.narrativeEvents, project.composition?.reactiveSections])}`}
          project={project} sections={candidate?.sections || []} disabled={!!busy} onSave={saveEvents} onPendingChange={setEventPending} />
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
          <button type="button" className={`${buttonCls} bg-port-accent text-white`} disabled={!!busy || eventPending || !authoringValid} onClick={generate}>
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
            <button type="button" className={buttonCls} disabled={!!busy || eventPending || !selectedSectionValid || candidate.stale || !authoringValid} onClick={regenerate}>
              <RotateCcw size={14} /> {busy === 'regenerate' ? <>Regenerating… <ElapsedSeconds /></> : 'Regenerate section'}
            </button>
            <button type="button" className={buttonCls} disabled={!!busy || eventPending || !candidate.eventRevisionAvailable || !authoringValid} onClick={reviseEvents}>
              {busy === 'event-revision' ? 'Revising events…' : 'Revise events only'}
            </button>
          </>}
        </div>
        {candidate?.stale && <p className="text-xs text-port-warning" role="status">{candidate.eventRevisionAvailable ? 'Event bindings changed. Revise events only to retain selected footage.' : 'The treatment, song or selected assets changed. Generate a fresh candidate.'}</p>}
      </StageSection>

      {candidate?.candidate && <StageSection id="mv-doc-candidate" title="Candidate review" summary="Compare and accept or discard" defaultOpen>
        <div className="rounded border border-port-border p-2">
          <p className="mb-2 text-xs text-port-text-muted">Candidate preview · {candidate.providerId || 'provider'} / {candidate.model || 'default model'} · active document stays selected until accepted</p>
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {doc?.source?.kind === 'generated' && <div><p className="text-xs text-port-text-muted">Before · accepted section</p><CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={comparisonSeek} /></div>}
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
      </StageSection>}

      <OverlayEditor key={`${project.id}-${project.composition?.overlay ? 'hud' : 'none'}`} project={project} onSave={onSave} />
      {doc && <DocumentFiles key={doc.directory} projectId={project.id} directory={doc.directory} />}
    </section>
  );
}
