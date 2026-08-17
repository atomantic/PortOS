/**
 * MusicGenPanel — on-device music generation for the Track editor.
 *
 * Lets the user pick a generation engine (MusicGen / AudioLDM2 / ACE-Step /
 * MiniMax Music 3 and MiniMax Music 3 MLX), pick or install a model, and Generate
 * audio from the track's prompt (+ lyrics for lyric-aware engines like ACE-Step
 * and MiniMax Music 3), with an explicit instrumental-only override for every
 * engine. On success the parent receives the updated track (the server attaches
 * the audio + gen metadata).
 *
 * Engines that aren't provisioned (their opt-in venv is missing) are shown with
 * an in-app install action and the Generate button is gated — mirroring the FLUX.2
 * venv gate in image gen. Additional HuggingFace checkpoints can be installed
 * inline (streamed download), then selected immediately.
 *
 * A fixed-model engine (MiniMax-Music3) needs BOTH a runtime venv and a fixed
 * weights download, and neither is useful alone. The setup banner therefore
 * carries ONE action that installs whatever is still missing: it opens the
 * runtime installer first when that's absent, then — once the refreshed engine
 * list confirms the venv landed — chains straight into the weights download
 * without the user having to find a second button.
 */

import { useEffect, useMemo, useState } from 'react';
import useMounted from '../../hooks/useMounted';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { Loader2, Wand2, Download, X } from 'lucide-react';
import toast from '../ui/Toast';
import { analyzeMusicLyrics } from '../../lib/musicDuration.js';
import { formatDurationSec } from '../../utils/formatters.js';
import {
  listMusicEngines, generateMusic, installAudioModel, removeAudioModel, getActiveProcessing, getMediaJob, getTrack, cancelMediaJob,
} from '../../services/api';
import { formatDownloadGb } from '../../utils/formatters';
import RuntimeInstallModal from '../install/RuntimeInstallModal';

/**
 * What an engine still needs, the sentence explaining it, and the label for the
 * one button that fixes it. Single derivation so the banner text and the button
 * can't disagree, and so the handlers branch on the same flags the UI shows
 * rather than re-deriving them.
 *
 * `label` is null when there's nothing to install — the engine is provisioned,
 * or it's CUDA-only on a host with no usable NVIDIA GPU, where an install button
 * would just be a slower way to fail.
 */
function engineSetupState(engine, selectedModelReady = null, selectedModelSizeGb = null) {
  if (!engine) return null;
  const needsRuntime = engine.runtimeReady !== true;
  const needsWeights = engine.fixedModelInstall === true
    && (selectedModelReady === null ? engine.modelReady === false : selectedModelReady === false);
  // Older servers do not send a VRAM verdict. Preserve their CUDA-only
  // behavior during rolling upgrades; a new explicit verdict is authoritative.
  const vramBlocked = engine.cudaRequired === true
    && engine.vramState != null
    && engine.vramState !== 'sufficient';
  const blocked = engine.platformSupported === false
    || (engine.cudaRequired === true && engine.cudaState !== 'available')
    || vramBlocked;

  let message;
  if (engine.platformSupported === false) message = `${engine.name} requires ${engine.platformLabel || 'a different host'} and is unavailable on this machine.`;
  else if (engine.cudaRequired === true && engine.cudaState === 'unknown') message = `${engine.name} is disabled because CUDA availability could not be determined.`;
  else if (engine.cudaRequired === true && engine.cudaState !== 'available') message = `${engine.name} requires an NVIDIA CUDA GPU and is unavailable on this host.`;
  else if (engine.cudaRequired === true && engine.vramState === 'insufficient') message = `${engine.name} requires at least ${engine.minVramGb} GB of VRAM for the ${engine.vramProfileLabel || 'selected'} profile; this host reports ${engine.maxVramGb} GB.`;
  else if (engine.cudaRequired === true && engine.vramState === 'unknown-size') message = `${engine.name} cannot run because the GPU VRAM requirement has not been measured for the ${engine.vramProfileLabel || 'selected'} execution profile.`;
  else if (engine.runtimeReady === false && needsWeights) message = `${engine.name} needs its runtime and model weights before generation.`;
  else if (engine.runtimeReady === false) message = `${engine.name} needs its runtime before generation.`;
  else if (needsWeights) message = `${engine.name} ${engine.modelReadyById && selectedModelReady === false ? 'selected model weights' : 'model weights'} are not installed yet.`;
  else message = `${engine.name} is not installed yet. Install the runtime to enable generation.`;

  const size = formatDownloadGb(selectedModelSizeGb ?? engine.modelSizeGb);
  const suffix = size ? ` (${size})` : '';
  let label = null;
  if (!blocked && needsRuntime && needsWeights) label = `Install runtime + weights${suffix}`;
  else if (!blocked && needsRuntime) label = 'Install runtime';
  else if (!blocked && needsWeights) label = `Download model weights${suffix}`;

  return { needsRuntime, needsWeights, blocked, message, label };
}

function supportsAutoDuration(engine) {
  // The server capability is authoritative: an older server may know the
  // MiniMax engine but will silently fall back to its fixed default when it
  // receives no lyric-aware duration implementation.
  return engine?.autoDuration === true;
}

function formatExecutionProfile(profile) {
  if (profile === 'cuda-bf16-full') return 'CUDA BF16 (full GPU)';
  if (profile === 'cuda-bf16-component-offload') return 'CUDA BF16 (component offload)';
  return profile || '';
}

export default function MusicGenPanel({ track, title = '', artistId = '', artist = '', albumId = '', prompt, lyrics, onGenerated, remix }) {
  const [engines, setEngines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [engineId, setEngineId] = useState('');
  const [modelId, setModelId] = useState('');
  const [durationSec, setDurationSec] = useState(null);
  const [durationMode, setDurationMode] = useState('auto');
  // Lyric text and vocal intent are independent: a lyricless prompt can still
  // ask for wordless vocals, so instrumental mode is always an explicit choice.
  const [instrumentalOnly, setInstrumentalOnly] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [generationElapsedSec, setGenerationElapsedSec] = useState(0);
  // Inline HF model install.
  const [installRepo, setInstallRepo] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState(null);
  // Progress for the setup action (runtime/fixed weights), rendered under the
  // setup banner. Kept apart from `installProgress`, which belongs to the
  // custom-HuggingFace-repo field further down.
  const [setupProgress, setSetupProgress] = useState(null);
  const [runtimeInstallEngine, setRuntimeInstallEngine] = useState(null);
  const [userSelectedEngine, setUserSelectedEngine] = useState(false);
  const mountedRef = useMounted();

  const refreshActiveJob = async () => {
    const snapshot = await getActiveProcessing({ silent: true });
    if (!mountedRef.current) return;
    const jobs = snapshot?.jobs || [];
    const found = jobs.find((job) => {
      const tag = job.params?.musicStudio;
      return job.kind === 'audio' && (track?.id ? tag?.trackId === track.id : tag && !tag.trackId);
    });
    if (found) {
      setActiveJob(found);
      setActiveJobId(found.id);
      if (typeof found.params?.musicStudio?.instrumentalOnly === 'boolean') {
        setInstrumentalOnly(found.params.musicStudio.instrumentalOnly);
      }
      setGenerating(true);
    } else if (progress.status !== 'completed') {
      setActiveJob(null);
      setActiveJobId(null);
    }
  };

  useAutoRefetch(refreshActiveJob, 3000, { pollOnly: true });
  const progress = useMediaJobProgress(activeJobId, { kind: 'audio' });
  const isGenerating = generating || ['queued', 'running'].includes(activeJob?.status) || ['queued', 'running'].includes(progress.status);

  useEffect(() => {
    if (!activeJobId || progress.status !== 'completed') return undefined;
    let canceled = false;
    const finish = async () => {
      const job = await getMediaJob(activeJobId).catch(() => null);
      const targetId = track?.id || job?.result?.trackId || progress.trackId;
      if (!targetId || canceled) return;
      let updated = null;
      for (let attempt = 0; attempt < 4 && !updated && !canceled; attempt += 1) {
        updated = await getTrack(targetId, { silent: true }).catch(() => null);
        if (!updated && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (canceled || !mountedRef.current) return;
      setGenerating(false);
      setActiveJob(null);
      setActiveJobId(null);
      if (updated) onGenerated?.(updated);
      toast.success('Track generated');
    };
    finish();
    return () => { canceled = true; };
  }, [activeJobId, progress.status, progress.trackId, track?.id]);

  // Returns the freshly-fetched list as well as storing it: the post-runtime
  // chain below needs the NEW engine record, and reading `engine` off state
  // right after setEngines() would still see the pre-install one.
  const loadEngines = async () => {
    const data = await listMusicEngines({ silent: true }).catch(() => null);
    if (!mountedRef.current) return [];
    const list = Array.isArray(data?.engines) ? data.engines : [];
    setEngines(list);
    setLoading(false);
    // Default to the first READY engine, else the server default, else the first.
    if (!engineId && list.length) {
      const ready = list.find((e) => e.ready);
      const pick = ready || list.find((e) => e.id === data.defaultEngine) || list[0];
      setEngineId(pick.id);
    }
    return list;
  };

  useEffect(() => { loadEngines(); }, []);

  useEffect(() => {
    if (!isGenerating) return undefined;
    const startedAt = activeJob?.startedAt ? Date.parse(activeJob.startedAt) : Date.now();
    setGenerationElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = setInterval(() => {
      if (mountedRef.current) setGenerationElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isGenerating, activeJob?.startedAt]);

  const engine = useMemo(() => engines.find((e) => e.id === engineId) || null, [engines, engineId]);
  const selectedModel = engine?.models?.find((item) => item.id === modelId)
    || engine?.models?.find((item) => item.id === engine.defaultModelId)
    || engine?.models?.[0]
    || null;
  // A native <select> displays its first option while React is applying the
  // engine's default id. Use that effective option for readiness and generation
  // too, so the first paint cannot briefly disable an otherwise ready engine.
  const selectedModelId = selectedModel?.id || modelId;
  const selectedModelReady = !engine?.fixedModelInstall
    ? true
    : engine?.modelReadyById
      ? engine.modelReadyById[selectedModelId] === true
      : engine.modelReady === true;
  const autoDurationAvailable = supportsAutoDuration(engine);
  const hasLyrics = typeof lyrics === 'string' && lyrics.trim().length > 0;
  const conditioningLyrics = engine?.lyrics && !instrumentalOnly ? lyrics : '';
  const lyricDuration = useMemo(() => analyzeMusicLyrics(conditioningLyrics, {
    minDurationSec: Math.max(60, engine?.defaultDurationSec || 60),
    maxDurationSec: engine?.maxDurationSec || 300,
  }), [conditioningLyrics, engine?.defaultDurationSec, engine?.maxDurationSec]);
  const usingAutoDuration = autoDurationAvailable && durationMode === 'auto';

  // A render-level choice must not leak into another track in the master-detail
  // editor. Each destination starts in the backward-compatible vocal-capable mode.
  useEffect(() => { setInstrumentalOnly(false); }, [track?.id]);

  // Remix: seed the engine / model / duration from a past render. Keyed on
  // `remix.nonce` (bumped per Remix click) so re-clicking the SAME render
  // re-applies even when its values are unchanged. An uploaded render carries no
  // engineId — skip the engine swap then and just keep the user's current
  // selection (the parent still prefills the prompt/lyrics form fields). Setting
  // engineId + modelId together lets the engine-validity effect below keep the
  // seeded model (it's in the engine's list because the engine produced it).
  useEffect(() => {
    if (!remix) return;
    if (remix.engineId) setEngineId(remix.engineId);
    if (remix.modelId) setModelId(remix.modelId);
    // Legacy/uploaded renders have no explicit mode. Do not infer vocal intent
    // from an empty lyric snapshot; start those remixes vocal-capable.
    setInstrumentalOnly(remix.instrumentalOnly === true);
    if (remix.durationSec != null) {
      setDurationSec(remix.durationSec);
      // Remix means "recreate this take"; preserve its exact manual ceiling.
      setDurationMode('manual');
    }
  }, [remix?.nonce]);

  // Keep the model selection valid for the current engine: reset to the engine
  // default ONLY when the selected model isn't in this engine's list. Keying on
  // engine.id (not the object) + this guard means a list refresh after installing
  // a model (which replaces the engines array but keeps the same engine id) does
  // NOT clobber a freshly-selected model — it stays selected because it's now in
  // the list. Switching to a different engine still resets (the old model isn't
  // in the new engine's list). Duration seeds once.
  useEffect(() => {
    if (!engine) return;
    const ids = (engine.models || []).map((m) => m.id);
    if (!ids.includes(modelId)) setModelId(engine.defaultModelId || ids[0] || '');
    setDurationSec((d) => (d == null ? engine.defaultDurationSec : d));
  }, [engine?.id, engine?.models]);

  const canGenerate = !!engine?.ready && selectedModelReady && !!prompt?.trim() && !isGenerating;
  const selectedModelSizeGb = engine?.modelSizeGbById?.[selectedModelId] ?? null;
  const setup = engineSetupState(engine, selectedModelReady, selectedModelSizeGb);
  const activeRender = track?.renders?.find((render) => render.audioFilename === track.audioFilename);
  const effectiveExecutionProfile = activeRender && activeRender.engine === engine?.id
    ? activeRender.executionProfile
    : null;

  // `target` is the engine record to install for — passed explicitly by the
  // post-runtime chain, which holds a fresher record than component state does.
  const installFixedModel = async (target) => {
    const eng = target || engine;
    const selectedId = eng?.id === engine?.id ? selectedModelId : '';
    const model = eng?.models?.find((item) => item.id === selectedId)
      || eng?.models?.find((item) => item.id === eng.defaultModelId)
      || eng?.models?.[0];
    if (!eng || !model?.repo) return;
    setInstalling(true);
    setSetupProgress({ message: `Starting ${model.name}…` });
    let failed = false;
    await installAudioModel({ engine: eng.id, repo: model.repo }, (ev) => {
      if (!mountedRef.current) return;
      if (ev.type === 'progress') setSetupProgress({ message: `${ev.file || 'downloading'} — ${Math.round((ev.progress || 0) * 100)}%`, progress: ev.progress });
      else if (ev.type === 'stage') setSetupProgress({ message: ev.stage });
      else if (ev.type === 'error') { failed = true; toast.error(ev.message || 'Download failed'); }
    }).catch((err) => { failed = true; if (mountedRef.current) toast.error(err.message || 'Install failed'); });
    if (!mountedRef.current) return;
    setInstalling(false);
    setSetupProgress(null);
    if (!failed) { await loadEngines(); toast.success(`${model.name} installed`); }
  };

  // The banner's one setup action. Runtime first when it's missing — weights are
  // useless without an interpreter to load them — otherwise straight to weights.
  const handleSetupInstall = async () => {
    if (!setup || setup.blocked) return;
    if (setup.needsRuntime) { setRuntimeInstallEngine(engine); return; }
    await installFixedModel(engine);
  };

  // Runtime installer closed: refresh, then continue into the weights — but only
  // once the refreshed record shows the venv actually landed, so a cancelled or
  // failed runtime install can't kick off a multi-GB pull with nothing to run it.
  const handleRuntimeInstallClose = async () => {
    setRuntimeInstallEngine(null);
    const list = await loadEngines();
    if (!mountedRef.current) return;
    const fresh = list.find((e) => e.id === engineId);
    const freshSelectedModelReady = !fresh?.fixedModelInstall
      ? true
      : fresh?.modelReadyById
        ? fresh.modelReadyById[selectedModelId] === true
        : fresh.modelReady === true;
    const freshSetup = engineSetupState(fresh, freshSelectedModelReady, fresh?.modelSizeGbById?.[selectedModelId] ?? null);
    if (freshSetup && !freshSetup.blocked && !freshSetup.needsRuntime && freshSetup.needsWeights) {
      await installFixedModel(fresh);
    }
  };

  const handleGenerate = async () => {
    if (!engine) return;
    if (!prompt?.trim()) { toast.error('Add a generation prompt first'); return; }
    setGenerating(true);
    const body = {
      prompt: prompt.trim(),
      engine: engine.id,
      modelId: selectedModelId,
      instrumentalOnly,
    };
    if (engine.lyrics) {
      // Keep authored lyrics available to the track record even when the server
      // deliberately excludes them from this render's engine conditioning.
      body.lyrics = lyrics || '';
    }
    if (track?.id) body.trackId = track.id;
    else {
      body.title = title.trim();
      body.artistId = artistId;
      body.artist = artist;
      body.albumId = albumId;
    }
    if (usingAutoDuration) body.durationMode = 'auto';
    else if (Number.isFinite(durationSec)) body.durationSec = durationSec;
    const res = await generateMusic(body, { silent: true }).catch((err) => { toast.error(err.message || 'Generation failed'); return null; });
    if (!mountedRef.current) return;
    if (res?.track) {
      // Compatibility with an older server during a rolling upgrade. New
      // servers always return the queued job acknowledgement below.
      setGenerating(false);
      onGenerated?.(res.track);
      toast.success('Track generated');
    } else if (res?.jobId) {
      setActiveJob({
        id: res.jobId,
        status: res.status,
        queuedAt: new Date().toISOString(),
        params: { musicStudio: { trackId: track?.id || null, instrumentalOnly } },
      });
      setActiveJobId(res.jobId);
    } else {
      setGenerating(false);
      toast.error('Music generation did not return a job');
    }
  };

  const handleCancel = async () => {
    if (!activeJobId) return;
    await cancelMediaJob(activeJobId, { silent: true }).catch((err) => toast.error(err.message || 'Cancel failed'));
    if (mountedRef.current) {
      setGenerating(false);
      setActiveJob(null);
      setActiveJobId(null);
    }
  };

  const handleInstall = async () => {
    const repo = installRepo.trim();
    if (!repo || !engine) return;
    setInstalling(true);
    setInstallProgress({ message: `Starting ${repo}…` });
    // Track failure across the stream: an `error` frame OR a thrown request
    // (e.g. a 400 invalid-repo) means the install did NOT succeed, so we must
    // not then clear the field / select the repo / report "Installed".
    let failed = false;
    await installAudioModel({ engine: engine.id, repo }, (ev) => {
      if (!mountedRef.current) return;
      if (ev.type === 'progress') setInstallProgress({ message: `${ev.file || 'downloading'} — ${Math.round((ev.progress || 0) * 100)}%`, progress: ev.progress });
      else if (ev.type === 'stage') setInstallProgress({ message: ev.stage });
      else if (ev.type === 'error') { failed = true; toast.error(ev.message || 'Download failed'); }
    }).catch((err) => { failed = true; if (mountedRef.current) toast.error(err.message || 'Install failed'); });
    if (!mountedRef.current) return;
    setInstalling(false);
    setInstallProgress(null);
    if (failed) return; // leave the repo field intact so the user can retry/fix
    setInstallRepo('');
    await loadEngines(); // refresh model list (the new repo is now registered)
    setModelId(repo);
    toast.success(`Installed ${repo}`);
  };

  const handleRemoveModel = async (id) => {
    if (!engine) return;
    await removeAudioModel(engine.id, id, { silent: true }).catch((err) => { toast.error(err.message || 'Remove failed'); return null; });
    await loadEngines();
    if (modelId === id) setModelId(engine.defaultModelId || '');
  };

  if (loading) return <div className="text-xs text-gray-500">Loading generators…</div>;
  if (engines.length === 0) return <div className="text-xs text-gray-500">No music generators available.</div>;

  const selectedUserModel = engine?.models?.find((m) => m.id === modelId && m.userAdded);
  const showRuntimeInstallHint = !!engine && (!engine.ready || !selectedModelReady) && (!!prompt?.trim() || userSelectedEngine);

  return (
    <div className="space-y-2 border border-port-border rounded-lg p-3 bg-port-bg/40">
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <Wand2 size={14} className="text-port-accent" /> Generate audio on-device
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Engine</span>
          <select
            value={engineId}
            onChange={(e) => {
              setUserSelectedEngine(true);
              setEngineId(e.target.value);
            }}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            {engines.map((e) => (
              <option key={e.id} value={e.id}>{e.name}{e.platformSupported === false ? ' (unavailable on this host)' : e.cudaRequired && e.cudaState !== 'available' ? ' (CUDA unavailable)' : e.vramState === 'insufficient' ? ' (insufficient VRAM)' : e.vramState === 'unknown-size' ? ' (VRAM unknown)' : e.ready ? '' : ' (setup required)'}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Model</span>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            {(engine?.models || []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.userAdded ? ' (installed)' : ''}</option>
            ))}
          </select>
        </label>
      </div>

      {effectiveExecutionProfile ? (
        <p className="text-[11px] text-gray-400">
          Active render profile: <span className="text-gray-300">{formatExecutionProfile(effectiveExecutionProfile)}</span>
        </p>
      ) : engine?.executionProfile ? (
        <p className="text-[11px] text-gray-500">
          Execution profile: {engine.vramProfileLabel || formatExecutionProfile(engine.executionProfile)}
        </p>
      ) : null}

      <div className={autoDurationAvailable ? 'grid grid-cols-2 gap-2' : undefined}>
        {autoDurationAvailable ? (
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Duration mode</span>
            <select
              id="musicgen-duration-mode"
              value={durationMode}
              onChange={(e) => setDurationMode(e.target.value)}
              className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
            >
              <option value="auto">Auto — let MiniMax choose</option>
              <option value="manual">Manual</option>
            </select>
          </label>
        ) : null}
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
            Duration (s){engine ? ` — ${engine.minDurationSec}–${engine.maxDurationSec}` : ''}
          </span>
          <input
            id="musicgen-duration"
            type="number"
            value={usingAutoDuration ? lyricDuration.suggestedDurationSec : (durationSec ?? '')}
            min={engine?.minDurationSec}
            max={engine?.maxDurationSec}
            disabled={usingAutoDuration}
            onChange={(e) => {
              setDurationMode('manual');
              setDurationSec(e.target.value === '' ? null : Number(e.target.value));
            }}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-70"
          />
        </label>
      </div>

      {autoDurationAvailable ? (
        <div className="rounded-lg border border-port-accent/20 bg-port-accent/5 px-3 py-2 text-[11px]">
          {lyricDuration.hasLyrics ? (
            <p className="text-gray-300">
              Auto sets a <span className="font-medium text-port-accent">{formatDurationSec(lyricDuration.suggestedDurationSec)}</span> ceiling from {lyricDuration.wordCount} lyric words {lyricDuration.sectionCount > 0 ? <>across {lyricDuration.sectionCount} tagged section{lyricDuration.sectionCount === 1 ? '' : 's'}</> : 'with no tagged sections detected'}, with room for the ending. MiniMax may finish earlier when the composition resolves.
            </p>
          ) : (
            <p className="text-gray-300">
              Auto uses a {formatDurationSec(lyricDuration.suggestedDurationSec)} ceiling because there is no lyric text to measure; MiniMax may finish earlier.
            </p>
          )}
          {lyricDuration.sectionCount === 0 && lyricDuration.hasLyrics ? (
            <p className="mt-1 text-gray-500">No structured lyric sections detected. Add tags such as [intro], [verse], [chorus], and [outro] so MiniMax can pace the composition more reliably.</p>
          ) : null}
          {lyricDuration.sectionCount > 0 && !lyricDuration.hasOutro && lyricDuration.hasLyrics ? (
            <p className="mt-1 text-gray-500">No [outro] section detected. Auto leaves extra room, but an explicit [outro] marker gives the ending clearer structure.</p>
          ) : null}
          {lyricDuration.isCapped ? (
            <p className="mt-1 text-port-warning">These lyrics estimate beyond MiniMax’s five-minute limit, so the final lines may still need to be shortened or split into another render.</p>
          ) : null}
        </div>
      ) : null}
      {autoDurationAvailable && !usingAutoDuration && lyricDuration.hasLyrics && Number.isFinite(durationSec) && durationSec < lyricDuration.suggestedDurationSec ? (
        <p className="text-[11px] text-port-warning">
          This manual ceiling is shorter than the lyric estimate ({formatDurationSec(lyricDuration.suggestedDurationSec)}); the last section or outro may be cut off.
        </p>
      ) : null}

      {showRuntimeInstallHint ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-port-warning/30 bg-port-warning/10 px-3 py-2">
          <p className="text-[11px] text-port-warning">
            {setup.message}
          </p>
          {setup.label ? <button
            type="button"
            onClick={handleSetupInstall}
            disabled={installing}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap px-3 py-1.5 rounded-lg bg-port-bg border border-port-warning/50 text-port-warning text-xs font-medium hover:border-port-warning disabled:opacity-50"
          >
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {setup.label}
          </button>
          : null}
        </div>
      ) : null}
      {setupProgress ? (
        <p className="truncate text-[11px] text-gray-500">{setupProgress.message}</p>
      ) : null}
      <div className="rounded-lg border border-port-border bg-port-bg px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            id="musicgen-instrumental-only"
            type="checkbox"
            checked={instrumentalOnly}
            onChange={(event) => setInstrumentalOnly(event.target.checked)}
            disabled={isGenerating}
            aria-describedby="musicgen-instrumental-only-hint"
            className="h-4 w-4 accent-port-accent"
          />
          <label htmlFor="musicgen-instrumental-only" className="text-sm font-medium text-gray-300">
            Instrumental only
          </label>
        </div>
        <p id="musicgen-instrumental-only-hint" className="mt-1 text-[11px] text-gray-500">
          {instrumentalOnly
            ? `An explicit no-vocals instruction will be added${hasLyrics ? '; saved lyrics will not condition this render' : ''}.`
            : engine?.lyrics && hasLyrics
              ? 'This engine will use the track’s lyrics as conditioning.'
              : 'No lyric text will condition this render, but vocals may still follow the prompt unless instrumental mode is enabled.'}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          title={!prompt?.trim() ? 'Add a generation prompt' : !engine?.ready ? 'Complete engine setup first' : !selectedModelReady ? 'Install the selected model first' : track?.id ? 'Generate audio' : 'Generate and create a standalone track'}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {isGenerating ? 'Generating…' : track?.id ? 'Generate' : 'Generate track'}
        </button>
        {selectedUserModel ? (
          <button
            type="button"
            onClick={() => handleRemoveModel(selectedUserModel.id)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-400 hover:text-port-error text-xs"
            title="Remove this installed model"
          >
            <X size={12} /> Remove model
          </button>
        ) : null}
      </div>
      {isGenerating ? (
        <div role="status" className="rounded-lg border border-port-accent/30 bg-port-accent/10 px-3 py-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-gray-300">
              {activeJob?.status === 'queued' ? `Queued${activeJob.position ? ` · position ${activeJob.position}` : ''}` : engine?.cudaRequired ? 'Processing on the GPU' : 'Rendering audio'}
            </span>
            <span className="font-mono tabular-nums text-port-accent">
              {Math.floor(generationElapsedSec / 60)}:{String(generationElapsedSec % 60).padStart(2, '0')} elapsed
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-port-border" aria-hidden="true">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-port-accent" />
          </div>
          <p className="mt-1.5 text-[11px] text-gray-500">
            {engine?.id === 'minimax-music3'
              ? 'MiniMax Music 3 does not report an exact percentage yet; a 60-second track can take tens of minutes on a 24 GB GPU.'
              : engine?.id === 'minimax-music3-mlx'
                ? 'MiniMax Music 3 MLX does not report an exact percentage yet; the first render includes model loading.'
                : 'Generation is still active. Longer requested durations take more time.'}
          </p>
          {activeJobId ? <button type="button" onClick={handleCancel} className="mt-2 text-[11px] text-port-warning hover:text-white">Cancel render</button> : null}
        </div>
      ) : null}

      {/* Install an additional model from HuggingFace — only for engines that
          can render an arbitrary checkpoint (musicgen/audioldm2). ACE-Step uses
          a fixed foundation checkpoint, so the install affordance is hidden. */}
      {engine?.customModels ? (
      <div className="pt-2 border-t border-port-border/60">
        <label htmlFor="musicgen-install-repo" className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Install a model from HuggingFace</label>
        <div className="flex items-center gap-2">
          <input
            id="musicgen-install-repo"
            value={installRepo}
            onChange={(e) => setInstallRepo(e.target.value)}
            placeholder="org/model-repo"
            disabled={installing}
            className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing || !installRepo.trim()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
          >
            {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Install
          </button>
        </div>
        {installProgress ? <p className="text-[11px] text-gray-500 mt-1 truncate">{installProgress.message}</p> : null}
      </div>
      ) : null}
      <RuntimeInstallModal
        open={!!runtimeInstallEngine}
        runtime={runtimeInstallEngine?.id}
        label={runtimeInstallEngine?.name}
        installUrlBase="/api/music/setup/runtime-install"
        description="Installing the music runtime and python packages. Large downloads may take several minutes."
        onClose={handleRuntimeInstallClose}
      />
    </div>
  );
}
