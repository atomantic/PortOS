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
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import ModelInputPreview from '../media/ModelInputPreview';
import SentPromptPanel from '../media/SentPromptPanel';
import { Loader2, Wand2, X } from 'lucide-react';
import toast from '../ui/Toast';
import { analyzeMusicLyrics } from '../../lib/musicDuration.js';
import { generateMusic, previewMusicPrompt } from '../../services/apiMusic.js';
import { useFederatedMediaTarget } from '../../hooks/useFederatedMediaTarget.js';
import RemoteMediaTargetPicker from '../federatedMedia/RemoteMediaTargetPicker';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import useMusicGenerationJob from './useMusicGenerationJob.js';
import useMusicEngineSelection from './useMusicEngineSelection.js';
import useMusicModelInstall from './useMusicModelInstall.js';
import MusicDurationControls from './MusicDurationControls.jsx';
import MusicGenerationStatus from './MusicGenerationStatus.jsx';
import { DEFAULT_REMOTE_PROFILE, ExecutionProfileNote, InstrumentalToggle, ModelInstallForm, RemoteProfileFields, SetupBanner } from './MusicGenSections.jsx';
import { buildGenerateBody, engineSetupState, isEngineModelReady, supportsAutoDuration } from './musicEngineModels.js';
import { engineOptionLabel, generateButtonTitle } from './musicGenLabels.js';

const SELECT_CLASS = 'w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm';

export default function MusicGenPanel({ track, title = '', artistId = '', artist = '', albumId = '', prompt, lyrics, onGenerated, remix }) {
  // Peer list, per-kind allowlist intersection, readiness verdict and the
  // submit-time re-check all live in the shared hook (#4348), so this panel,
  // Image Gen and Video Gen cannot read the same peer three different ways.
  const remoteTarget = useFederatedMediaTarget('audio');
  const [remoteProfile, setRemoteProfile] = useState(() => ({ ...DEFAULT_REMOTE_PROFILE }));
  const [durationSec, setDurationSec] = useState(null);
  const [durationMode, setDurationMode] = useState('auto');
  // Lyric text and vocal intent are independent: a lyricless prompt can still
  // ask for wordless vocals, so instrumental mode is always an explicit choice.
  const [instrumentalOnly, setInstrumentalOnly] = useState(false);
  const [userSelectedEngine, setUserSelectedEngine] = useState(false);
  const mountedRef = useMounted();
  const job = useMusicGenerationJob({ track, onGenerated, onDiscoveredInstrumental: setInstrumentalOnly });
  const { isGenerating } = job;

  const selectedRemoteModel = remoteTarget.model;
  useEffect(() => {
    if (!selectedRemoteModel) return;
    setDurationSec((current) => current == null
      || current < selectedRemoteModel.minDurationSec
      || current > selectedRemoteModel.maxDurationSec
      ? selectedRemoteModel.defaultDurationSec
      : current);
  }, [selectedRemoteModel?.engine, selectedRemoteModel?.modelId]);

  // A render-level choice must not leak into another track in the master-detail
  // editor. Each destination starts in the backward-compatible vocal-capable mode.
  useEffect(() => { setInstrumentalOnly(false); }, [track?.id]);
  const { engines, loading, engineId, setEngineId, modelId, setModelId, engine, selectedModelId, loadEngines, handleRemoveModel } = useMusicEngineSelection({ remix, setDurationSec, setDurationMode, setInstrumentalOnly });
  const selectedRemotePeer = remoteTarget.peer;
  const isRemote = remoteTarget.isRemote;
  const generationEngine = isRemote ? selectedRemoteModel : engine;
  const selectedModelReady = isEngineModelReady(engine, selectedModelId);
  const autoDurationAvailable = supportsAutoDuration(generationEngine);
  const hasLyrics = typeof lyrics === 'string' && lyrics.trim().length > 0;
  // Two independent facts, and the server refuses the combination where they
  // disagree (ADR docs/decisions/2026-08-22-federated-media-input-assets.md
  // rule 2): `lyrics` is the model's own capability, while the `lyrics` FEATURE
  // is whether the peer's BUILD carries the words at all. Why an absent feature
  // must read as false lives in `federatedMediaSupports`, not here.
  const remoteLyricsAvailable = isRemote
    && generationEngine?.lyrics === true
    && remoteTarget.supports('lyrics');
  // Remote renders that cannot carry lyrics are instrumental by construction,
  // not by choice — the checkbox reflects that rather than pretending the user
  // picked it. Where the peer CAN sing, it is an ordinary choice again.
  const forcedInstrumental = isRemote && !remoteLyricsAvailable;
  const effectiveInstrumentalOnly = forcedInstrumental || instrumentalOnly;
  const captionPreview = useModelInputPreview(previewMusicPrompt, {
    prompt, lyrics, engine: engine?.id, instrumentalOnly: effectiveInstrumentalOnly,
    durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
    durationMode: autoDurationAvailable ? durationMode : 'manual',
  }, { enabled: !isRemote && !!prompt?.trim() });
  const lyricsCondition = !isRemote || remoteLyricsAvailable;
  const conditioningLyrics = generationEngine?.lyrics && !effectiveInstrumentalOnly && lyricsCondition
    ? lyrics
    : '';
  const lyricDuration = useMemo(() => analyzeMusicLyrics(conditioningLyrics, {
    minDurationSec: Math.max(60, generationEngine?.defaultDurationSec || 60),
    maxDurationSec: generationEngine?.maxDurationSec || 300,
  }), [conditioningLyrics, generationEngine?.defaultDurationSec, generationEngine?.maxDurationSec]);
  const usingAutoDuration = autoDurationAvailable && durationMode === 'auto';


  const canGenerate = (isRemote ? remoteTarget.canSubmit : !!engine?.ready && selectedModelReady)
    && !!prompt?.trim() && !isGenerating;
  const selectedModelSizeGb = engine?.modelSizeGbById?.[selectedModelId] ?? null;
  const setup = isRemote ? null : engineSetupState(engine, selectedModelReady, selectedModelSizeGb);
  const activeRender = track?.renders?.find((render) => render.audioFilename === track.audioFilename);
  const effectiveExecutionProfile = activeRender && activeRender.engine === engine?.id
    ? activeRender.executionProfile
    : null;
  const install = useMusicModelInstall({ engine, engineId, selectedModelId, setup, loadEngines, setModelId });

  const handleGenerate = async () => {
    if (!generationEngine) return;
    if (!prompt?.trim()) { toast.error('Add a generation prompt first'); return; }
    // The button's own reading is as old as the last render, and a capacity
    // window expires on the clock rather than on a state change — so between
    // polls an enabled button can already be pointing at a stale peer. Re-derive
    // now, and say so here instead of letting the server reject a submission the
    // user just committed to.
    if (isRemote) {
      const fresh = remoteTarget.verify();
      if (!fresh.ok) { toast.error(fresh.message); return; }
    }
    job.setGenerating(true);

    const body = buildGenerateBody({
      prompt, lyrics, track, title, artistId, artist, albumId, generationEngine, engine, selectedModelId, isRemote,
      selectedRemotePeer, remoteProfile, remoteLyricsAvailable, effectiveInstrumentalOnly, usingAutoDuration, durationSec,
    });
    const res = await generateMusic(body, { silent: true }).catch((err) => { toast.error(err.message || 'Generation failed'); return null; });
    if (!mountedRef.current) return;
    if (res?.track) {
      // Compatibility with an older server during a rolling upgrade. New
      // servers always return the queued job acknowledgement below.
      job.setGenerating(false);
      onGenerated?.(res.track);
      toast.success('Track generated');
    } else if (res?.jobId) {
      job.trackQueuedJob({
        id: res.jobId,
        status: res.status,
        queuedAt: new Date().toISOString(),
        params: { musicStudio: { trackId: track?.id || null, instrumentalOnly } },
      });
    } else {
      job.setGenerating(false);
      toast.error('Music generation did not return a job');
    }
  };

  if (loading) return <div className="text-xs text-gray-500">Loading generators…</div>;
  if (engines.length === 0) return <div className="text-xs text-gray-500">No music generators available.</div>;

  const selectedUserModel = engine?.models?.find((m) => m.id === modelId && m.userAdded);
  const showRuntimeInstallHint = !isRemote && !!engine && (!engine.ready || !selectedModelReady) && (!!prompt?.trim() || userSelectedEngine);

  return (
    <div className="space-y-2 border border-port-border rounded-lg p-3 bg-port-bg/40">
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <Wand2 size={14} className="text-port-accent" /> Generate audio on-device
      </div>

      <RemoteMediaTargetPicker target={remoteTarget} kind="audio">
        <RemoteProfileFields remoteProfile={remoteProfile} setRemoteProfile={setRemoteProfile} remoteLyricsAvailable={remoteLyricsAvailable} />
      </RemoteMediaTargetPicker>

      {!isRemote && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Engine</span>
            <select
              value={engineId}
              onChange={(e) => {
                setUserSelectedEngine(true);
                setEngineId(e.target.value);
              }}
              className={SELECT_CLASS}
            >
              {engines.map((e) => <option key={e.id} value={e.id}>{engineOptionLabel(e)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Model</span>
            {/* The EFFECTIVE id, not the raw state. `modelId` is '' until the
                engine-defaults effect drains, and React leaves a select alone
                when no option matches its value — so the raw state would let
                the control display one snapshot while every readiness gate
                below reads another, for as long as that gap lasts. */}
            <select value={selectedModelId} onChange={(e) => setModelId(e.target.value)} className={SELECT_CLASS}>
              {(engine?.models || []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.userAdded ? ' (installed)' : ''}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <ExecutionProfileNote activeProfile={effectiveExecutionProfile} engine={engine} />

      <MusicDurationControls
        engine={generationEngine}
        autoDurationAvailable={autoDurationAvailable}
        usingAutoDuration={usingAutoDuration}
        durationMode={durationMode}
        setDurationMode={setDurationMode}
        durationSec={durationSec}
        setDurationSec={setDurationSec}
        lyricDuration={lyricDuration}
      />

      {showRuntimeInstallHint ? <SetupBanner setup={setup} installing={install.installing} onInstall={install.handleSetupInstall} /> : null}
      {install.setupProgress ? (
        <p className="truncate text-[11px] text-gray-500">{install.setupProgress.message}</p>
      ) : null}
      <InstrumentalToggle
        checked={effectiveInstrumentalOnly}
        onChange={setInstrumentalOnly}
        disabled={isGenerating || forcedInstrumental}
        hintArgs={{ forcedInstrumental, generationEngine, effectiveInstrumentalOnly, hasLyrics, isRemote }}
      />

      {!isRemote && <ModelInputPreview preview={captionPreview} prompt={prompt} />}
      {!isRemote && typeof captionPreview.preview?.sentLyrics === 'string' && (
        <section aria-label="Lyrics sent to the model" className="text-xs space-y-1">
          <p className="text-gray-500">Lyrics sent to the model</p>
          <SentPromptPanel
            prompt={effectiveInstrumentalOnly ? '' : lyrics || ''}
            sentPrompt={captionPreview.preview.sentLyrics}
            additions={captionPreview.preview.lyricAdditions || []}
          />
        </section>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          title={generateButtonTitle({ prompt, isRemote, remoteTarget, engine, selectedModelReady, track })}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {isGenerating ? 'Generating…' : track?.id ? 'Generate' : 'Generate track'}
        </button>
        {!isRemote && selectedUserModel ? (
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
        <MusicGenerationStatus
          activeJob={job.activeJob}
          activeJobId={job.activeJobId}
          generationEngine={generationEngine}
          elapsedSec={job.elapsedSec}
          onCancel={job.cancel}
        />
      ) : null}

      {engine?.customModels ? (
        <ModelInstallForm
          installRepo={install.installRepo}
          setInstallRepo={install.setInstallRepo}
          installing={install.installing}
          installProgress={install.installProgress}
          onInstall={install.handleInstall}
        />
      ) : null}
      <RuntimeInstallModal
        open={!!install.runtimeInstallEngine}
        runtime={install.runtimeInstallEngine?.id}
        label={install.runtimeInstallEngine?.name}
        installUrlBase="/api/music/setup/runtime-install"
        streamMethod="POST"
        description="Installing the music runtime and python packages. Large downloads may take several minutes."
        onClose={install.handleRuntimeInstallClose}
      />
    </div>
  );
}
