import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { updateMusicVideoProject } from '../services/apiMusicVideo.js';
import { getVideoGenStatus, listLorasFull } from '../services/apiImageVideo.js';

const isLtx23 = (model) => !!model
  && model.runtime === 'ltx2'
  && /ltx.?2\.3|ltx23/i.test(`${model.id} ${model.name || ''} ${model.repo || ''}`);

/**
 * A music-video project's saved render pins — the video backend/model/LoRA the
 * scene clips are generated with, plus the image-side frame pin (#3231 Phase 4).
 * Renderer/model is a project-level production decision, not a transient browser
 * preference, so each change is persisted (optimistic-local + silent PATCH,
 * rollback + toast on failure) before new jobs are allowed; `saving` gates the
 * dependent generate buttons so the job payload and the board's displayed
 * setting cannot disagree.
 *
 * Also owns the Video Gen catalog (installed models + LoRAs) the pickers read.
 * `onProjectPatch(projectId, patch)` shallow-merges the patch into the caller's
 * local copy of that project.
 */
export default function useMusicVideoModelSettings({ project, onProjectPatch } = {}) {
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [loras, setLoras] = useState([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getVideoGenStatus({ silent: true })
      .then((status) => {
        // Music-video scenes always start from a reference frame. Hide
        // explicitly text-only models, while retaining general LTX models
        // whose runtime supports both text and image conditioning.
        setModels((status?.models || []).filter((model) => model.mode !== 't2v' && !model.deprecated));
        setDefaultModel(status?.defaultModel || '');
        setModelsLoading(false);
      })
      .catch(() => {
        setModels([]);
        setDefaultModel('');
        setModelsLoading(false);
      });
    listLorasFull({ silent: true })
      .then((installed) => setLoras(Array.isArray(installed) ? installed : []))
      .catch(() => setLoras([]));
  }, []);

  const settings = {
    // Empty means this peer resolves its own configured Video Gen default.
    // Synced projects intentionally arrive without another install's backend
    // pin, so do not turn that absence into an explicit local override.
    backend: project?.videoSettings?.backend || '',
    // Empty is an intentional "follow the local Video Gen default" choice,
    // distinct from pinning the model that happens to be default today.
    modelId: project?.videoSettings?.modelId || '',
    grokDuration: project?.videoSettings?.grokDuration || 10,
    generationMode: project?.videoSettings?.generationMode || 'image',
    audioReactiveLora: project?.videoSettings?.audioReactiveLora || '',
    audioReactiveScale: project?.videoSettings?.audioReactiveScale ?? 1.2,
  };
  const effectiveModelId = settings.modelId || defaultModel;
  const activeModel = models.find((model) => model.id === effectiveModelId) || null;
  const audioReactiveModels = models.filter(isLtx23);
  const audioReactiveLoras = loras.filter((lora) =>
    /audio-reactive/i.test(`${lora.filename} ${lora.name || ''}`)
    && (lora.loraCompatKey || lora.runnerFamily) === 'ltx-video');
  const detectedAudioReactiveLora = loras.find((lora) =>
    lora.filename === settings.audioReactiveLora)
    || audioReactiveLoras.find((lora) =>
      /(?:^|[-_.\s])v2(?:[-_.\s]|$)/i.test(`${lora.filename} ${lora.name || ''}`))
    || audioReactiveLoras[0]
    || null;
  const audioReactiveReady = !!(isLtx23(activeModel) && detectedAudioReactiveLora);
  const audioReactiveSelected = settings.backend === 'local' && settings.generationMode === 'audioReactive';

  const change = (patch) => {
    if (!project || saving) return;
    const projectId = project.id;
    const previous = project.videoSettings;
    const next = { ...settings, ...patch };
    onProjectPatch?.(projectId, { videoSettings: next });
    setSaving(true);
    updateMusicVideoProject(projectId, { videoSettings: patch }, { silent: true })
      .then((updated) => onProjectPatch?.(projectId, {
        videoSettings: updated.videoSettings,
        updatedAt: updated.updatedAt,
      }))
      .catch((err) => {
        onProjectPatch?.(projectId, { videoSettings: previous });
        toast.error(err?.message || 'Failed to save video renderer');
      })
      .finally(() => setSaving(false));
  };

  // #3231 Phase 4 — per-project frame-render pin (`imageMode`/`imageModelId`),
  // the image-side sibling of the video renderer pin above. Scene
  // reference-frame renders send no explicit mode, so the server resolves this
  // record pin directly (imageGen/prepareParams) — no client seeding needed.
  const changeFramePin = ({ imageMode, imageModelId }) => {
    if (!project) return;
    const projectId = project.id;
    const previous = { imageMode: project.imageMode ?? null, imageModelId: project.imageModelId ?? null };
    onProjectPatch?.(projectId, { imageMode, imageModelId });
    updateMusicVideoProject(projectId, { imageMode, imageModelId }, { silent: true })
      .then((updated) => onProjectPatch?.(projectId, {
        imageMode: updated.imageMode ?? null,
        imageModelId: updated.imageModelId ?? null,
        updatedAt: updated.updatedAt,
      }))
      .catch((err) => {
        onProjectPatch?.(projectId, previous);
        toast.error(err?.message || 'Failed to save frame renderer');
      });
  };

  return {
    models,
    modelsLoading,
    defaultModel,
    saving,
    settings,
    effectiveModelId,
    activeModel,
    audioReactiveModels,
    audioReactiveLoras,
    detectedAudioReactiveLora,
    audioReactiveReady,
    audioReactiveSelected,
    change,
    changeFramePin,
  };
}
