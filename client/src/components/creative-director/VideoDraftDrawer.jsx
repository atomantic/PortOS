import { useRunwayCatalog } from '../../hooks/useRunwayCatalog.js';
import { VIDEO_REVIEW_CHECKPOINTS } from '../../../../server/lib/creativeDirectorPresets.js';
import { VIDEO_RENDER_MODES, modeLabel } from '../../lib/imageGenBackends.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, getRunwayVideoModel } from '../../lib/runwayVideoModels.js';
import { useEffect, useMemo, useState } from 'react';
import Drawer from '../Drawer.jsx';
import useListResource from '../../hooks/useListResource.js';
import ListLoadError from '../ui/ListLoadError.jsx';
import useDrawerTab from '../../hooks/useDrawerTab.js';
import toast from '../ui/Toast';
import { createCreativeDirectorProject, updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
import { startVideoFromStoryboard } from '../../services/apiStoryboards.js';
import { storyboardVideoPlan } from '../../../../server/lib/storyboardVideo.js';
import { ASPECT_RATIOS } from '../../../../server/lib/creativeDirectorPresets.js';
import StoryboardVideoShots from './StoryboardVideoShots.jsx';
import { listUniverseNames } from '../../services/apiUniverseBuilder.js';
import { listPipelineSeriesNames } from '../../services/apiPipeline.js';
import { listCatalogIngredients } from '../../services/apiCatalog.js';
import { listMusicEngines } from '../../services/apiMusic.js';
import { listTracks } from '../../services/apiTracks.js';
import { listVideoModels } from '../../services/apiImageVideo.js';
import { Clapperboard, FileText, Library } from 'lucide-react';

const TABS = [{ id: 'brief', label: 'Brief', icon: FileText }, { id: 'production', label: 'Production', icon: Clapperboard }, { id: 'sources', label: 'Sources', icon: Library }];
// Module-level so each fetcher identity is stable for useListResource.
const fetchTracks = () => listTracks({ silent: true }).then(data => Array.isArray(data) ? data : data?.tracks || []);
const fetchEngines = () => listMusicEngines({ silent: true }).then(data => data?.engines || []);
const fetchModels = () => listVideoModels({ silent: true }).then(m => m || []);
const fieldClass = 'w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-2 text-sm';

// `storyboard` starts a new draft from that board: its panels become the shots and set the length.
export default function VideoDraftDrawer({ open, onClose, project, onSaved, catalogIngredientIds = [], storyboard = null }) {
  const [tab, setTab] = useDrawerTab('videoDraftTab', 'brief', TABS.map(t => t.id));
  const [form, setForm] = useState({});
  const runwayCatalog = useRunwayCatalog(open && form.videoMode === 'runway');
  const modelsRes = useListResource(fetchModels, { enabled: open });
  const enginesRes = useListResource(fetchEngines, { enabled: open });
  const tracksRes = useListResource(fetchTracks, { enabled: open });
  const { items: models } = modelsRes;
  const { items: engines } = enginesRes;
  const { items: tracks } = tracksRes;
  const [sourceOptions, setSourceOptions] = useState({});
  const [sourceKind, setSourceKind] = useState('universe');
  const [sourceId, setSourceId] = useState('');
  const [sourceQuery, setSourceQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const plan = useMemo(() => (open && storyboard && !project ? storyboardVideoPlan(storyboard) : null), [open, storyboard, project]);
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setSourceId('');
    setSourceQuery('');
    const draft = project?.videoDraft;
    setForm({ name: project?.name || storyboard?.name || '', userStory: project?.userStory || storyboard?.logline || '', styleSpec: project?.styleSpec || '',
      videoMode: project?.renderBackend?.video?.mode || 'local', backendModelId: project?.renderBackend?.video?.modelId || '',
      aspectRatio: project?.aspectRatio || (ASPECT_RATIOS.includes(storyboard?.aspectRatio) ? storyboard.aspectRatio : '16:9'), quality: project?.quality || 'standard', modelId: (project?.renderBackend?.video?.mode === 'local' ? project.renderBackend.video.modelId : '') || project?.modelId || '',
      min: draft?.durationRange?.min || 30, max: draft?.durationRange?.max || 60,
      reviewPolicy: draft?.reviewPolicy || 'review', transition: draft?.transition || 'cut', audioMode: draft?.audio?.mode || 'native', trackId: draft?.audio?.trackId || '', audioPrompt: draft?.audio?.prompt || '', audioProvider: draft?.audio?.providerId || '', audioModel: draft?.audio?.model || '',
      sources: draft?.sources || catalogIngredientIds.map(id => ({ kind: 'catalog', id })) });
    const rows = data => Array.isArray(data) ? data : data?.items || data?.series || data?.universes || [];
    Promise.all([listUniverseNames({ silent: true }), listPipelineSeriesNames({ silent: true }), listCatalogIngredients({ limit: 100, silent: true })]).then(([u, s, c]) => { if (active) setSourceOptions({ universe: rows(u), series: rows(s), catalog: rows(c) }); }).catch(() => { if (active) toast.error('Unable to load source choices. Close and reopen to retry.'); });
    return () => { active = false; };
  }, [open, project?.id, storyboard?.id]);
  const change = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const input = (key, label, options = {}) => <label htmlFor={`video-draft-${key}`} className="block text-sm">{label}<input id={`video-draft-${key}`} className={fieldClass} value={form[key] ?? ''} onChange={e => change(key, e.target.value)} {...options} /></label>;
  const loadError = (res, what) => res.state === 'error' ? <ListLoadError className="mt-1" what={what} error={res.error} onRetry={res.retry} /> : null;
  const select = (key, label, choices, loadFailure = null) => <><label htmlFor={`video-draft-${key}`} className="block text-sm">{label}<select id={`video-draft-${key}`} className={fieldClass} value={form[key] || ''} onChange={e => change(key, e.target.value)}>{choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>{loadFailure}</>;
  const exactTarget = plan ? plan.totalSeconds : Math.min(Number(form.max), Math.max(Number(form.min), project?.targetDurationSeconds ?? Number(form.max)));
  const save = async () => {
    if (!form.name?.trim()) { setTab('brief'); toast.error('Name is required'); return; }
    if (plan?.problem) { setTab('brief'); toast.error(plan.problem); return; }
    const min = plan ? exactTarget : Number(form.min), max = plan ? exactTarget : Number(form.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 5 || max > 600 || min > max) { setTab('brief'); toast.error('Choose a duration range between 5 and 600 seconds, minimum first'); return; }
    const sources = form.sources || [];
    const payload = { name: form.name.trim(), userStory: form.userStory, styleSpec: form.styleSpec,
      aspectRatio: form.aspectRatio, quality: form.quality, modelId: form.modelId, targetDurationSeconds: exactTarget,
      ...(!project ? { workspace: 'video', catalogIngredientIds: sources.filter(s => s.kind === 'catalog').map(s => s.id) } : {}),
      renderBackend: { ...project?.renderBackend, video: { ...project?.renderBackend?.video, mode: form.videoMode, modelId: form.videoMode === 'local' ? form.modelId : form.backendModelId || null } },
      videoDraft: { durationRange: { min, max }, sources, transition: form.transition, audio: { mode: form.audioMode, ...(form.trackId ? { trackId: form.trackId } : {}), ...(form.audioPrompt ? { prompt: form.audioPrompt } : {}), ...(form.audioProvider ? { providerId: form.audioProvider } : {}), ...(form.audioModel ? { model: form.audioModel } : {}) }, reviewPolicy: form.reviewPolicy, checkpoints: project?.videoDraft?.checkpoints || VIDEO_REVIEW_CHECKPOINTS } };
    setSaving(true);
    const saved = await (project ? updateCreativeDirectorProject(project.id, payload, { silent: true })
      : plan ? startVideoFromStoryboard(storyboard.id, { boardUpdatedAt: storyboard.updatedAt, project: payload }, { silent: true }).then(res => res.project)
        : createCreativeDirectorProject(payload, { silent: true }))
      .catch(err => { toast.error(err.message || 'Unable to save video draft'); return null; });
    setSaving(false);
    if (saved) { onClose(); onSaved(saved); toast.success(project?.status && project.status !== 'draft' ? 'Production settings saved' : 'Video draft saved'); }
  };
  return <Drawer open={open} onClose={onClose} title={project ? !project.status || project.status === 'draft' ? 'Edit video draft' : 'Edit production settings' : plan ? 'Video from storyboard' : 'New video draft'} subtitle="Saving makes no provider calls. Start or resume production when ready." size="lg" tabs={TABS} activeTab={tab} onTabChange={setTab} closeOnEsc={false} closeOnBackdrop={false}>
    <fieldset disabled={saving} className="space-y-4">
      {tab === 'brief' && <>
        {input('name', 'Name', { maxLength: 200 })}
        <label htmlFor="video-draft-userStory" className="block text-sm">Brief<textarea id="video-draft-userStory" value={form.userStory || ''} onChange={e => change('userStory', e.target.value)} className={fieldClass} rows={4} maxLength={10000} /></label>
        <label htmlFor="video-draft-styleSpec" className="block text-sm">Style<textarea id="video-draft-styleSpec" value={form.styleSpec || ''} onChange={e => change('styleSpec', e.target.value)} className={fieldClass} rows={3} maxLength={5000} /></label>
        {plan ? <StoryboardVideoShots plan={plan} /> : <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{input('min', 'Minimum duration (seconds)', { type: 'number', min: 5, max: 600 })}{input('max', 'Maximum duration (seconds)', { type: 'number', min: 5, max: 600 })}</div>
        <p className="text-sm text-port-text-muted" aria-live="polite">Exact target: {Number.isFinite(exactTarget) && Number(form.min) <= Number(form.max) ? `${exactTarget} seconds` : 'Choose a valid range'}. Existing targets are preserved within the range; new drafts use the maximum.</p>
        </>}
      </>}
      {tab === 'production' && <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{select('aspectRatio', 'Aspect ratio', ['16:9', '9:16', '1:1'].map(x => [x, x]))}{select('quality', 'Quality', ['draft', 'standard', 'high'].map(x => [x, x]))}</div>
        <h3 className="font-medium">Cognitive models</h3><p className="text-sm text-port-text-muted">Inherit Creative Director defaults. After saving, use Models to select providers and models separately for treatment, production planning, and evaluation.</p>
        <label htmlFor="video-draft-videoMode" className="block text-sm">Media backend<select id="video-draft-videoMode" className={fieldClass} value={form.videoMode || 'local'} onChange={e => { change('videoMode', e.target.value); change('backendModelId', ''); }}>{!VIDEO_RENDER_MODES.includes(form.videoMode) && form.videoMode && <option value={form.videoMode}>{form.videoMode} (saved backend)</option>}{VIDEO_RENDER_MODES.map(mode => <option key={mode} value={mode}>{modeLabel(mode)}</option>)}</select></label>
        {form.videoMode === 'local' ? select('modelId', 'Media model', [['', 'Choose before production'], ...(form.modelId && !models.some(m => m.id === form.modelId) ? [[form.modelId, `${form.modelId} (saved model unavailable)`]] : []), ...models.map(m => [m.id, m.name || m.id])], loadError(modelsRes, 'media models'))
          : form.videoMode === 'fal' ? input('backendModelId', 'fal.ai model (optional)', { placeholder: 'Use configured fal.ai default', maxLength: 64 })
          : form.videoMode === 'runway' ? select('backendModelId', 'Runway model', [['', `${getRunwayVideoModel(RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL).label} (backend default)`], ...(form.backendModelId && !runwayCatalog.videoModels.some((m) => m.id === form.backendModelId) ? [[form.backendModelId, `${form.backendModelId} (saved model unavailable)`]] : []), ...runwayCatalog.videoModels.map(m => [m.id, m.label])])
          : select('backendModelId', 'Media model', [['', form.videoMode === 'reactor' ? 'fast-h3 (backend default)' : 'Backend default'], ...(form.backendModelId ? [[form.backendModelId, `${form.backendModelId} (saved model)`]] : [])])}
        <p className="text-sm text-port-text-muted">Backend selections are saved without running providers. Cloud renders may incur charges when production is enabled.</p>
        {select('transition', 'Shot joins', [['cut', 'Straight cuts'], ['fade', 'Fade through black (no overlap)']])}
        <h3 className="font-medium">Soundtrack</h3>
        {select('audioMode', 'Audio contract', [['silent', 'Silent (remove audio)'], ['native', 'Native audio from every clip'], ['imported', 'Existing Music track'], ['generated', 'Generate one soundtrack bed']])}
        {form.audioMode === 'imported' && select('trackId', 'Soundtrack track', [['', 'Choose a track'], ...tracks.filter(track => track.audioFilename).map(track => [track.id, track.title || track.id])], loadError(tracksRes, 'soundtrack tracks'))}
        {form.audioMode === 'generated' && input('audioPrompt', 'Soundtrack description', { maxLength: 1000 })}
        <p className="text-sm text-port-text-muted">Native audio requires audio in every clip; it does not guarantee dialogue or lip sync. Soundtracks replace clip audio and repeat to fill the cut. Generated audio uses one bounded job unless you authorize a retry.</p>
        {form.audioMode === 'generated' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label htmlFor="video-draft-audioProvider" className="block text-sm">Audio engine<select id="video-draft-audioProvider" className={fieldClass} value={form.audioProvider || ''} onChange={e => { change('audioProvider', e.target.value); change('audioModel', ''); }}><option value="">Choose before production</option>{engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name || engine.id}</option>)}</select></label>{loadError(enginesRes, 'audio engines')}</div>{select('audioModel', 'Audio model', [['', 'Engine default'], ...(engines.find(e => e.id === form.audioProvider)?.models || []).map(m => [m.id, m.name || m.id])])}</div>}
        {select('reviewPolicy', 'Review policy', [['review', 'Review at checkpoints'], ['autonomous', 'Autonomous after production is enabled']])}
        <p className="text-sm text-port-text-muted">Checkpoints: script and shot plan, references, rough cut, final cut. Start authorizes the displayed provider choices and limits. Creative changes require a fresh review.</p>
      </>}
      {tab === 'sources' && <>
        {sourceKind === 'catalog' && <div className="flex items-end gap-2"><label htmlFor="video-source-search" className="flex-1">Search catalog<input id="video-source-search" className={fieldClass} value={sourceQuery} onChange={e => setSourceQuery(e.target.value)} /></label><button onClick={() => { setSourceId(''); listCatalogIngredients({ q: sourceQuery, limit: 100, silent: true }).then(data => setSourceOptions(prev => ({ ...prev, catalog: Array.isArray(data) ? data : data?.items || [] }))).catch(() => toast.error('Unable to search catalog')); }} className="px-3 py-2 rounded border border-port-border">Search</button></div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label htmlFor="video-source-kind">Source collection<select id="video-source-kind" className={fieldClass} value={sourceKind} onChange={e => { setSourceKind(e.target.value); setSourceId(''); }}><option value="universe">Universes</option><option value="series">Series</option><option value="catalog">Catalog</option></select></label>
          <label htmlFor="video-source-record">Source<select id="video-source-record" className={fieldClass} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">Choose a source</option>{(sourceOptions[sourceKind] || []).map(source => <option key={source.id} value={source.id}>{source.name || source.title || source.id}</option>)}</select></label>
        </div>
        <button disabled={!sourceId || (form.sources || []).length >= 50} onClick={() => { if (!(form.sources || []).some(s => s.kind === sourceKind && s.id === sourceId)) change('sources', [...(form.sources || []), { kind: sourceKind, id: sourceId }]); setSourceId(''); }} className="px-3 py-2 rounded border border-port-border disabled:opacity-50">Add source</button>
        <ul className="space-y-2">{(form.sources || []).map(source => <li key={`${source.kind}:${source.id}`} className="flex items-center justify-between gap-2 border border-port-border rounded p-2"><span>{source.kind}: {sourceOptions[source.kind]?.find(s => s.id === source.id)?.name || sourceOptions[source.kind]?.find(s => s.id === source.id)?.title || source.id}</span><button aria-label={`Remove ${source.kind} source ${source.id}`} onClick={() => change('sources', form.sources.filter(s => s !== source))}>Remove</button></li>)}</ul>
        <p className="text-sm text-port-text-muted">Attach up to 50 sources from existing creative records. Imported music and voice references remain attached until you remove them.</p>
      </>}
      <div className="flex justify-end gap-2 border-t border-port-border pt-4"><button disabled={saving} onClick={onClose} className="px-3 py-2 rounded border border-port-border">Cancel</button><button disabled={saving || !!plan?.problem} onClick={save} className="px-3 py-2 rounded bg-port-accent text-white disabled:opacity-50">{saving ? 'Saving…' : project?.status && project.status !== 'draft' ? 'Save production settings' : 'Save draft'}</button></div>
    </fieldset>
  </Drawer>;
}
