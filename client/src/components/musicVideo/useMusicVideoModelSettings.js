/**
 * A project's saved render pins — video backend
 * (local/Grok/fal.ai)/model/generation-mode/audio-reactive LoRA + the image-side frame pin — with the
 * Video Gen catalog they read from.
 *
 * Optimistic-local + silent PATCH, rollback + toast on failure; `saving` gates the dependent generate
 * buttons. Returns `{ models, modelsLoading, catalogStatus ('loading'|'ready'|'error'), retryCatalog,
 * defaultModel, falEnabled (null until read), runwayEnabled, saving, settings, effectiveModelId,
 * activeModel, audioReactiveModels, audioReactiveLoras, detectedAudioReactiveLora, audioReactiveReady,
 * audioReactiveSelected, videoBlockedReason, change, changeFramePin }`. `videoBlockedReason` is the
 * single "why can't I generate" string (an unavailable audio-reactive setup, or a fal.ai pin with no
 * configured API key; a pending or failed catalog read says so instead of claiming a missing key)
 * shared by the disabled buttons, their tooltips, and the blocked-call toast. Use when: The Music
 * Video renderer selects and anything building a scene-clip job payload from them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../ui/Toast';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';
import { getVideoGenModelContext, listLorasFull } from '../../services/apiImageVideo.js';
import { loraFamilyOf, VIDEO_LORA_FAMILIES } from '../../lib/runnerFamilies';
import { LTX_REFERENCES_GENERATION_MODE, isLtx25Model } from '../../lib/musicVideoLtxReferences.js';

const isLtx23 = (model) => !!model
  && model.runtime === 'ltx2'
  && /ltx.?2\.3|ltx23/i.test(`${model.id} ${model.name || ''} ${model.repo || ''}`);

function normalizeVideoSettings(project) {
  const saved = project?.videoSettings;
  return {
    renderPool: saved?.renderPool,
    // Empty means this peer resolves its own configured Video Gen default.
    // Synced projects intentionally arrive without another install's backend
    // pin, so do not turn that absence into an explicit local override.
    backend: saved?.backend || '',
    // Empty is an intentional "follow the local Video Gen default" choice,
    // distinct from pinning the model that happens to be default today.
    modelId: saved?.modelId || '',
    grokDuration: saved?.grokDuration || 10,
    // null/absent means "use fal's model default duration" — distinct from an
    // explicit pin, same null-means-unset contract as modelId above.
    falDuration: saved?.falDuration ?? null,
    // fal cutaway model / its resolution, and the lip-sync take resolution —
    // null means "the default" (Hailuo-02 image-to-video / that model's own /
    // MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION), resolved by falSceneTake.
    falModelId: saved?.falModelId ?? null,
    falResolution: saved?.falResolution ?? null,
    // Upgrade model for end-frame shots only; null = they use falModelId.
    falEndFrameModelId: saved?.falEndFrameModelId ?? null,
    falLipSyncResolution: saved?.falLipSyncResolution ?? null,
    // false = lip-sync without transcript guidance (null/absent = on).
    falLipSyncTranscription: saved?.falLipSyncTranscription ?? null,
    // Audio-to-video model / resolution for music-driven performance takes —
    // null means FAL_MUSIC_VIDEO_DEFAULT_MODEL (MiniMax H3 Max reference) at its own default size, resolved by falSceneTake.
    falMusicModelId: saved?.falMusicModelId ?? null,
    falMusicResolution: saved?.falMusicResolution ?? null,
    // Runway cutaway model / clip length / size — null means the catalog
    // default (RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, the shot's covering length,
    // the project aspect), resolved by runwaySceneTake.
    higgsfieldModelId: saved?.higgsfieldModelId ?? null,
    higgsfieldDuration: saved?.higgsfieldDuration ?? null,
    higgsfieldResolution: saved?.higgsfieldResolution ?? null,
    googleModelId: saved?.googleModelId ?? null,
    googleDuration: saved?.googleDuration ?? null,
    googleResolution: saved?.googleResolution ?? null,
    runwayModelId: saved?.runwayModelId ?? null,
    runwayDuration: saved?.runwayDuration ?? null,
    runwayResolution: saved?.runwayResolution ?? null,
    // #16136: ceilings for the shot card's Render draft / Render final; null = the model's lowest / highest tier.
    draftResolution: saved?.draftResolution ?? null,
    finalResolution: saved?.finalResolution ?? null,
    upscaleMethod: saved?.upscaleMethod,
    upscaleTargetResolution: saved?.upscaleTargetResolution,
    generationMode: saved?.generationMode || 'image',
    audioReactiveLora: saved?.audioReactiveLora || '',
    audioReactiveScale: saved?.audioReactiveScale ?? 1.2,
  };
}

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
  const [statusRead, setStatusRead] = useState('loading');
  const [loraRead, setLoraRead] = useState('loading');
  const [loras, setLoras] = useState([]);
  const [defaultModel, setDefaultModel] = useState('');
  // null = unknown (read pending or failed) — never collapsed into "not configured".
  const [falEnabled, setFalEnabled] = useState(null);
  const [runwayEnabled, setRunwayEnabled] = useState(null);
  const [higgsfieldEnabled, setHiggsfieldEnabled] = useState(null);
  const [googleEnabled, setGoogleEnabled] = useState(null);
  const catalogGeneration = useRef(0);
  const [saving, setSaving] = useState(false);
  const [framePinSaving, setFramePinSaving] = useState(false);

  // A superseded read (retry, unmount) is dropped by the generation check.
  const loadCatalog = useCallback(() => {
    const generation = ++catalogGeneration.current;
    const current = () => generation === catalogGeneration.current;
    setStatusRead('loading');
    setLoraRead('loading');
    getVideoGenModelContext({ silent: true })
      .then((status) => {
        if (!current()) return;
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
        setRunwayEnabled(status?.runwayEnabled === true);
        setHiggsfieldEnabled(status?.higgsfieldEnabled === true);
        setGoogleEnabled(status?.googleEnabled === true);
        setStatusRead('ready');
      })
      .catch(() => { if (current()) setStatusRead('error'); });
    listLorasFull({ silent: true })
      .then((installed) => {
        if (!current()) return;
        setLoras(Array.isArray(installed) ? installed : []);
        setLoraRead('ready');
      })
      .catch(() => { if (current()) setLoraRead('error'); });
  }, []);

  useEffect(() => {
    loadCatalog();
    return () => { catalogGeneration.current += 1; };
  }, [loadCatalog]);

  const combinedStatus = (...reads) => (reads.includes('error') ? 'error' : reads.includes('loading') ? 'loading' : 'ready');
  const catalogStatus = combinedStatus(statusRead, loraRead);
  const modelsLoading = statusRead === 'loading';

  const settings = normalizeVideoSettings(project);
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
  const ltxReferencesModels = models.filter(isLtx25Model);
  const ltxReferencesSelected = settings.backend === 'local' && settings.generationMode === LTX_REFERENCES_GENERATION_MODE;

  const cloudReadiness = new Map([
    ['fal', { enabled: falEnabled, reason: 'No fal.ai API key configured — set it in Settings → Credentials (or the FAL_KEY env var) first' }],
    ['runway', { enabled: runwayEnabled, reason: 'No Runway API key configured — set it in Settings → Credentials (or the RUNWAYML_API_SECRET env var) first' }],
    ['higgsfield', { enabled: higgsfieldEnabled, reason: 'No Higgsfield credential configured — set it in Settings → Credentials first' }],
    ['google', { enabled: googleEnabled, reason: 'No Google credential configured — set it in Settings → Credentials first' }],
  ]);

  // One reason string for every scene-video kickoff gate, so the disabled
  // buttons, their tooltips, and the toast a blocked call raises all say the
  // same resolvable thing. `null` means nothing is blocking. The fal.ai check
  // mirrors the general Video Gen page: an unconfigured backend is a clear
  // preflight reason rather than a request that reaches the server only to
  // fail with FAL_NOT_CONFIGURED (#8968) — no silent fallback to local/Grok.
  // `blockedReasonFor` answers the same for a one-shot render with other settings (a scene card's Render on pick).
  // While the catalog read is pending or failed the answer is unknown, so the
  // reason names that state instead of claiming a key or LoRA is missing.
  const blockedReasonFor = (pick) => {
    const cloud = cloudReadiness.get(pick.backend);
    const localMode = pick.backend === 'local' ? pick.generationMode : null;
    let reads = 'ready';
    if (localMode === 'audioReactive') reads = combinedStatus(statusRead, loraRead);
    else if (cloud || localMode === LTX_REFERENCES_GENERATION_MODE) reads = statusRead;
    if (reads === 'error') return "Couldn't read Video Gen status — retry before rendering";
    if (reads === 'loading') return 'Checking Video Gen status…';
    if (localMode === 'audioReactive' && !audioReactiveReady) {
      return 'Audio-reactive generation requires an installed LTX-2.3 audio-reactive LoRA and an LTX-2.3 local model';
    }
    if (localMode === LTX_REFERENCES_GENERATION_MODE) {
      const pickedModel = models.find((model) => model.id === (pick.modelId || defaultModel));
      if (!isLtx25Model(pickedModel)) return 'LTX 2.5 References requires an LTX 2.5 local model';
    }
    return cloud && !cloud.enabled ? cloud.reason : null;
  };
  const videoBlockedReason = blockedReasonFor(settings);

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
  // the image-side sibling of the video renderer pin above. A shot card can
  // name a service for one frame render. A render that sends no mode still
  // resolves this record pin (imageGen/prepareParams) — no client seeding needed.
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
    catalogStatus,
    statusRead,
    retryCatalog: loadCatalog,
    defaultModel,
    falEnabled,
    runwayEnabled,
    higgsfieldEnabled,
    googleEnabled,
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
    ltxReferencesModels,
    ltxReferencesSelected,
    videoBlockedReason,
    blockedReasonFor,
    change,
    changeFramePin,
  };
}
