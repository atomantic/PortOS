import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { updateMusicVideoProject } from '../services/apiMusicVideo.js';
import { getVideoGenStatus, listLorasFull } from '../services/apiImageVideo.js';
import { loraFamilyOf, VIDEO_LORA_FAMILIES } from '../lib/runnerFamilies';

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
  const [falEnabled, setFalEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [framePinSaving, setFramePinSaving] = useState(false);

  useEffect(() => {
    getVideoGenStatus({ silent: true })
      .then((status) => {
        // Music-video scenes always start from a reference frame. Hide
        // explicitly text-only models, while retaining general LTX models
        // whose runtime supports both text and image conditioning.
        setModels((status?.models || []).filter((model) => model.mode !== 't2v' && !model.deprecated));
        setDefaultModel(status?.defaultModel || '');
        // fal.ai's queue REST backend (#8968) — usability-gated on a
        // configured API key, computed server-side by the same
        // isVideoModeUsable() check a render itself is gated on (mirrors the
        // general Video Gen page's `falEnabled`).
        setFalEnabled(status?.falEnabled === true);
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
    renderPool: project?.videoSettings?.renderPool,
    // Empty means this peer resolves its own configured Video Gen default.
    // Synced projects intentionally arrive without another install's backend
    // pin, so do not turn that absence into an explicit local override.
    backend: project?.videoSettings?.backend || '',
    // Empty is an intentional "follow the local Video Gen default" choice,
    // distinct from pinning the model that happens to be default today.
    modelId: project?.videoSettings?.modelId || '',
    grokDuration: project?.videoSettings?.grokDuration || 10,
    // null/absent means "use fal's model default duration" — distinct from an
    // explicit pin, same null-means-unset contract as modelId above.
    falDuration: project?.videoSettings?.falDuration ?? null,
    // fal cutaway model / its resolution, and the lip-sync take resolution —
    // null means "the default" (Hailuo-02 image-to-video / that model's own /
    // MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION), resolved by falSceneTake.
    falModelId: project?.videoSettings?.falModelId ?? null,
    falResolution: project?.videoSettings?.falResolution ?? null,
    falLipSyncResolution: project?.videoSettings?.falLipSyncResolution ?? null,
    generationMode: project?.videoSettings?.generationMode || 'image',
    audioReactiveLora: project?.videoSettings?.audioReactiveLora || '',
    audioReactiveScale: project?.videoSettings?.audioReactiveScale ?? 1.2,
  };
  const effectiveModelId = settings.modelId || defaultModel;
  const activeModel = models.find((model) => model.id === effectiveModelId) || null;
  const audioReactiveModels = models.filter(isLtx23);
  const audioReactiveLoras = loras.filter((lora) =>
    /audio-reactive/i.test(`${lora.filename} ${lora.name || ''}`)
    && loraFamilyOf(lora) === VIDEO_LORA_FAMILIES.LTX_VIDEO);
  const detectedAudioReactiveLora = loras.find((lora) =>
    lora.filename === settings.audioReactiveLora)
    || audioReactiveLoras.find((lora) =>
      /(?:^|[-_.\s])v2(?:[-_.\s]|$)/i.test(`${lora.filename} ${lora.name || ''}`))
    || audioReactiveLoras[0]
    || null;
  const audioReactiveReady = !!(isLtx23(activeModel) && detectedAudioReactiveLora);
  const audioReactiveSelected = settings.backend === 'local' && settings.generationMode === 'audioReactive';

  // One reason string for every scene-video kickoff gate, so the disabled
  // buttons, their tooltips, and the toast a blocked call raises all say the
  // same resolvable thing. `null` means nothing is blocking. The fal.ai check
  // mirrors the general Video Gen page: an unconfigured backend is a clear
  // preflight reason rather than a request that reaches the server only to
  // fail with FAL_NOT_CONFIGURED (#8968) — no silent fallback to local/Grok.
  const videoBlockedReason = audioReactiveSelected && !audioReactiveReady
    ? 'Audio-reactive generation requires an installed LTX-2.3 audio-reactive LoRA and an LTX-2.3 local model'
    : settings.backend === 'fal' && !falEnabled
      ? 'No fal.ai API key configured — set it in Settings → Video Gen (or the FAL_KEY env var) first'
      : null;

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
  // `framePinSaving` is the image-side counterpart of `saving`, and carries the
  // same obligation: the optimistic patch repaints the picker immediately, but
  // the server resolves the RECORD pin at kickoff — so a frame render started
  // before the PATCH lands renders on the previous model while the board claims
  // the new one. It also serializes two quick pin changes, which would
  // otherwise race and could settle the record on the older of the two.
  const changeFramePin = ({ imageMode, imageModelId }) => {
    if (!project || framePinSaving) return;
    const projectId = project.id;
    const previous = { imageMode: project.imageMode ?? null, imageModelId: project.imageModelId ?? null };
    onProjectPatch?.(projectId, { imageMode, imageModelId });
    setFramePinSaving(true);
    updateMusicVideoProject(projectId, { imageMode, imageModelId }, { silent: true })
      .then((updated) => onProjectPatch?.(projectId, {
        imageMode: updated.imageMode ?? null,
        imageModelId: updated.imageModelId ?? null,
        updatedAt: updated.updatedAt,
      }))
      .catch((err) => {
        onProjectPatch?.(projectId, previous);
        toast.error(err?.message || 'Failed to save frame renderer');
      })
      .finally(() => setFramePinSaving(false));
  };

  return {
    models,
    modelsLoading,
    defaultModel,
    falEnabled,
    saving,
    framePinSaving,
    settings,
    effectiveModelId,
    activeModel,
    audioReactiveModels,
    audioReactiveLoras,
    detectedAudioReactiveLora,
    audioReactiveReady,
    audioReactiveSelected,
    videoBlockedReason,
    change,
    changeFramePin,
  };
}
