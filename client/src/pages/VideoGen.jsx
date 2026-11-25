/**
 * Video Generation page (LTX models via mlx_video on macOS, diffusers on
 * Windows), with local, Grok, and federated render targets.
 *
 * Accepts a source image either via direct upload or via the
 * `?sourceImageFile=` query param so the Image Gen page can pipe a generation
 * straight into video.
 *
 * Modes (UI state, also forwarded to the backend as `mode`):
 *   - text:   pure text-to-video
 *   - image:  image-to-video (one source image, current I2V behavior)
 *   - fflf:   first frame + last frame (two images — backend support is
 *             experimental; mlx_video only supports a single conditioning
 *             frame, so when both are provided the last is ignored)
 *   - extend: pick a previous render → its last frame becomes the source
 *             image for a new image-to-video generation
 *   - a2v:    audio-to-video (uploaded WAV/MP3 drives the video's motion +
 *             audio track) — LTX, or MiniMax H3 Ref2VA with an image
 *   - ic-*:   IC-LoRA remix modes (issue #3100) — a reference clip drives the
 *             render through ICLoraPipeline with a per-mode IC-LoRA fused into
 *             Stage 1. Today: `ic-control` (structure/motion from a depth/pose/
 *             edge clip) and `ic-colorize` (color restored onto a B&W clip).
 *             dgrauet/ltx2 runtime only; the mode list comes from
 *             IC_LORA_MODES in lib/videoGenParams.js.
 *
 * Form state, the URL-param prefill paths, the mode/backend transitions, and
 * `buildGeneratePayload()` live in `useVideoGenForm` (issue #3291), which
 * returns one named group per concern. This page wires the fetched context
 * (status, model context, history, weights) and the run pipeline to the panels
 * in `components/videoGen/`, handing each panel only the groups it renders.
 * The durable server queue owns queued work; each render target drains
 * through its own lane.
 *
 * "Add to queue" submits immediately to the durable server queue. That is
 * important for mixed-target work: a Grok submission can start in its cloud
 * lane while a local render occupies the GPU lane, and a federated peer owns
 * the queue for the work it receives.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown } from 'lucide-react';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import RenderStatusCard from '../components/videoGen/RenderStatusCard';
import VideoGenGallery from '../components/videoGen/VideoGenGallery';
import VideoGenStatusBar from '../components/videoGen/VideoGenStatusBar';
import { VideoGenBackendSwitch, VideoGenModeSwitch } from '../components/videoGen/VideoGenLaneSwitches';
import VideoGenFormNotices from '../components/videoGen/VideoGenFormNotices';
import VideoGenPromptField from '../components/videoGen/VideoGenPromptField';
import VideoGenPrimaryActions from '../components/videoGen/VideoGenPrimaryActions';
import VideoGenPromptStylePanel from '../components/videoGen/VideoGenPromptStylePanel';
import VideoGenSourceInputsPanel from '../components/videoGen/VideoGenSourceInputsPanel';
import VideoGenRenderSettingsPanel from '../components/videoGen/VideoGenRenderSettingsPanel';
import VideoGenEpisodeDrawer from '../components/videoGen/VideoGenEpisodeDrawer';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import MediaPreview from '../components/media/MediaPreview';
import VideoUpscaleDrawer from '../components/media/VideoUpscaleDrawer';
import MediaJobsQueue from '../components/media/MediaJobsQueue';
import toast from '../components/ui/Toast';
import { useVideoGenForm } from '../components/videoGen/useVideoGenForm.js';
import { useVideoGenServiceStatus } from '../hooks/useVideoGenServiceStatus.js';
import { useVideoGenEpisodeImport } from '../hooks/useVideoGenEpisodeImport.js';
import { useVideoGenHistory } from '../hooks/useVideoGenHistory.js';
import { useVideoGenRemixHandoff } from '../hooks/useVideoGenRemixHandoff.js';
import { useVideoGenRun } from '../hooks/useVideoGenRun.js';
import { useVideoGenByovRuntime } from '../hooks/useVideoGenByovRuntime.js';
import { useVideoGenWeightAssets } from '../hooks/useVideoGenWeightAssets.js';
import { useVideoGenSubmitGates } from '../hooks/useVideoGenSubmitGates.js';
import { useReactorContinuableClips } from '../hooks/useReactorContinuableClips.js';
import { useRunwayCatalog } from '../hooks/useRunwayCatalog.js';
import { useFederatedMediaTarget } from '../hooks/useFederatedMediaTarget';
import { useModelInputPreview } from '../hooks/useModelInputPreview';
import useListResource from '../hooks/useListResource';
import { generateVideo, listLorasFull, previewVideoPrompt } from '../services/apiImageVideo.js';
import { musicVideoFilingFields } from '../lib/musicVideoFiling';

// Stable fetcher for useListResource — the hook re-runs on identity change.
const loadLoraLibrary = () => listLorasFull({ silent: true });

export default function VideoGen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const episode = useVideoGenEpisodeImport({ searchParams, setSearchParams });
  const {
    status, statusLoading, refreshStatus, refreshGrokEnabled,
    modelContextRequest, modelContext, models, refreshModelContext, laneEnabled,
    byovRuntimes, backendDisclosures, displaySleepOnRender,
  } = useVideoGenServiceStatus();
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('settings', '1'); return n; });
  const closeSettings = () => {
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('settings'); return n; });
    // The drawer hosts the Grok enable toggle plus the hosted providers' API
    // key fields — re-read both so the backend switch appears/disappears
    // without a reload.
    refreshGrokEnabled();
    // Hosted-lane flags ride the model context, not the python probe.
    refreshModelContext();
    refreshStatus();
  };

  const [optionsOpen, setOptionsOpen] = useState(() => (
    window.matchMedia?.('(min-width: 1024px)').matches ?? true
  ));
  useEffect(() => {
    const desktopOptions = window.matchMedia?.('(min-width: 1024px)');
    if (!desktopOptions) return undefined;
    const syncOptionsToViewport = () => setOptionsOpen(desktopOptions.matches);
    syncOptionsToViewport();
    desktopOptions.addEventListener('change', syncOptionsToViewport);
    return () => desktopOptions.removeEventListener('change', syncOptionsToViewport);
  }, []);

  // Installed LoRA library — the picker filters this to the current model's
  // video family. A failed read is shown as such, with Retry, never as an
  // empty library.
  const loraLibrary = useListResource(loadLoraLibrary);

  // Federated render target (#4348). Picking a peer replaces the local runtime
  // outright — the clip is rendered there and imported back — so it feeds the
  // payload builder rather than sitting beside it.
  const remoteTarget = useFederatedMediaTarget('video');
  // `null` = no per-render override yet — follow the install default
  // (settings.videoGen.displaySleep, server-reported so it can't drift from
  // the server's own opt-in read). Set once the user touches the checkbox.
  // Computed before the form hook call because it feeds buildGeneratePayload()
  // the same way `remoteSubmissionFields` does.
  const [displaySleepOverride, setDisplaySleepOverride] = useState(null);
  const displaySleepEnabled = displaySleepOverride ?? displaySleepOnRender;
  const form = useVideoGenForm({
    models, modelContext, availableLoras: loraLibrary.items,
    grokEnabled: laneEnabled.grok, falEnabled: laneEnabled.fal, reactorEnabled: laneEnabled.reactor,
    runwayEnabled: laneEnabled.runway, geminiEnabled: laneEnabled.gemini,
    higgsfieldEnabled: laneEnabled.higgsfield, googleEnabled: laneEnabled.google,
    remoteSubmissionFields: remoteTarget.isRemote ? remoteTarget.submissionFields : null,
    displaySleepEnabled,
  });
  const {
    lane, prompt: promptFields, model, sampler, frames, keyframes, extend, audio, ic, references, actions,
    grok, fal, runway, higgsfield, google, reactor,
  } = form;
  const { mode, hostedLane } = lane;
  const { currentModel } = model;

  const selectMode = (nextMode) => {
    lane.handleModeChange(nextMode);
    // Non-text modes expose required conditioning inputs inside Options. Open
    // the panel when the mode changes so a touch user never has to infer why
    // Generate became disabled from a hover-only title.
    if (nextMode !== 'text') setOptionsOpen(true);
  };

  // Does an external provider API own this render? Its weights, sampler and
  // encoder are all on the far side of an HTTP call, so the local STAGE: ladder
  // (download weights → load model → encode → sample → mux) describes work this
  // machine never does and no marker ever lands on — which left the status card
  // pinned on "Loading model" for the whole render. The status card swaps in the
  // short submit / render / fetch ladder instead. A federated PEER is
  // deliberately excluded: it really does load the weights and run the sampler,
  // it just does so out of view.
  const rendersOffMachine = Boolean(hostedLane);
  const rendersOnThisMachine = !rendersOffMachine && !remoteTarget.isRemote;

  // Can THIS render put the display to sleep at all? The model says whether
  // its runtime needs the mitigation (mlx only); the other clauses rule out
  // backends the mitigation never applies to. UI-only: buildGeneratePayload()
  // decides independently (from currentModel alone) whether to attach the
  // choice, since its grok/fal/reactor/remote branches already return first.
  const canSleepDisplay = !!currentModel?.sleepsDisplayDuringRender
    && rendersOnThisMachine;
  const rendersSleepDisplay = canSleepDisplay && displaySleepEnabled;

  // Every gallery-image slot on this page (both frame panels, each multi-keyframe
  // row, each IC-LoRA reference row) opens the SAME GalleryImagePicker modal the
  // Image Gen i2i form uses — a searchable thumbnail grid over the whole gallery.
  // `null` = closed; otherwise `{ kind, index? }` records which slot the pick
  // lands in, since one modal serves every slot.
  const [galleryPicker, setGalleryPicker] = useState(null);
  const handleGalleryPick = (item) => {
    const filename = item?.filename;
    if (!filename || !galleryPicker) return;
    const { kind, index } = galleryPicker;
    if (kind === 'source') frames.pickSourceImage(filename);
    else if (kind === 'last') frames.pickLastImage(filename);
    else if (kind === 'keyframe') keyframes.updateKeyframe(index, { file: filename });
    else if (kind === 'icReference') ic.updateIcReferenceImage(index, filename);
    else if (kind === 'reference') references.updateReferenceImage(index, filename);
  };

  const history = useVideoGenHistory();
  const remix = useVideoGenRemixHandoff({
    searchParams, setSearchParams, models,
    applyRemix: actions.applyRemix, applyFinish: actions.applyFinish, historyState: history,
  });
  const run = useVideoGenRun({
    onCompleted: history.refreshHistory,
    onResumed: (job) => {
      actions.applyResumedParams(job.params || {});
      // The form hook doesn't own this page-level toggle — restore it directly
      // so a reload mid-render shows the choice that render is actually keeping.
      if (job.params?.displaySleep !== undefined) setDisplaySleepOverride(!!job.params.displaySleep);
    },
  });
  const byov = useVideoGenByovRuntime({ currentModel, byovRuntimes });
  const weights = useVideoGenWeightAssets({ model, ic, catalogLoading: modelContextRequest.state === 'loading', rendersOffMachine });

  // The form's request plus the music video it is filed under, if one is picked.
  const generatePayload = () => ({ ...actions.buildGeneratePayload(), ...musicVideoFilingFields(searchParams) });

  // The same request as Generate, each upload named instead of attached (#11317).
  const previewBody = (() => {
    const payload = generatePayload();
    const previewUploads = Object.keys(payload).filter((key) => payload[key] instanceof Blob);
    const fields = Object.fromEntries(Object.entries(payload).filter(([, value]) => !(value instanceof Blob)));
    return previewUploads.length ? { ...fields, previewUploads } : fields;
  })();
  const modelInputPreview = useModelInputPreview(previewVideoPrompt, previewBody, { enabled: promptFields.prompt.trim().length > 0 });

  const runwayCatalog = useRunwayCatalog(lane.isRunway, mode);
  // `status.connected` reflects the LEGACY mlx_video pythonPath health. BYOV
  // runtimes resolve their own venv inside the service layer, so a missing
  // legacy pythonPath must NOT block them — gate only on `byovRuntimeMissing`
  // for those models. Without this, a user who installed ONLY a BYOV runtime
  // via the modal would stay stuck behind a "not configured" error from the
  // unrelated legacy probe.
  const notConnected = !!status && status.connected === false && !byov.needsByovProbe;
  const reactorContinuableClips = useReactorContinuableClips({ visibleHistory: history.visibleHistory, reactor, mode });
  const gates = useVideoGenSubmitGates({
    form, remoteTarget, rendersOffMachine, rendersOnThisMachine,
    remixHandoffPending: remix.remixHandoffPending, notConnected, byov,
    blockedAsset: weights.blockedAsset, modelContext, modelContextRequest, runwayCatalog,
  });
  const { canEnqueue } = gates;

  const verifyRemoteTarget = () => {
    if (!remoteTarget.isRemote) return true;
    const fresh = remoteTarget.verify();
    if (!fresh.ok) { toast.error(fresh.message); return false; }
    return true;
  };

  const handleEnqueue = async () => {
    // Mirror the Generate guard — a BYOV runtime that isn't installed yet
    // would silently queue a doomed job that fails late in the worker with
    // VENV_MISSING, hiding the installer banner from the user. Block at
    // enqueue time so the only path forward is the install banner above.
    if (!canEnqueue) return;
    // A capacity window expires on the clock, so re-check the selected peer at
    // the moment this queued job is committed. The server then owns the job,
    // including any multipart uploads, and the appropriate lane can start it
    // without waiting for this tab's active SSE render.
    if (!verifyRemoteTarget()) return;
    await generateVideo(generatePayload())
      .then((data) => {
        const position = Number.isInteger(data?.position) ? ` (position ${data.position})` : '';
        toast.success(`Queued${position}`);
      })
      .catch((err) => toast.error(err.message || 'Failed to queue video'));
  };

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (run.generating) {
      if (canEnqueue) await handleEnqueue();
      return;
    }
    if (!canEnqueue) return;
    // A capacity window expires on the clock, so an enabled button can already
    // be pointing at a lapsed peer — re-derive at the moment of commit and say
    // so, rather than letting the peer reject a render already paid for.
    if (!verifyRemoteTarget()) return;
    await run.runGeneration(generatePayload()).catch(() => {});
  };

  const runwayPerformance = runway.runwayPerformance;

  return (
    <div className="space-y-3">
      <VideoGenStatusBar
        status={status}
        statusLoading={statusLoading}
        onRefresh={refreshStatus}
        onOpenEpisode={episode.openEpisodeComposer}
        onOpenSettings={openSettings}
      />

      <VideoGenBackendSwitch laneEnabled={laneEnabled} backend={lane.backend} onBackendChange={lane.handleBackendChange} />

      <VideoGenModeSwitch mode={mode} isRunway={lane.isRunway} rendersOffMachine={rendersOffMachine} onSelectMode={selectMode} />

      <form onSubmit={handleGenerate} className="@container/video-form min-w-0">
        <div className="min-w-0 bg-port-card border border-port-border rounded-xl p-4 space-y-3">
          <VideoGenFormNotices
            remixHandoff={remix}
            byov={byov}
            showByov={!rendersOffMachine}
            weights={weights}
            generating={run.generating}
          />
          {!runwayPerformance && (
            <VideoGenPromptField promptFields={promptFields} gates={gates} modelInputPreview={modelInputPreview} />
          )}

          <VideoGenPrimaryActions
            run={run}
            gates={gates}
            onEnqueue={handleEnqueue}
            unavailableReferenceImageNames={references.unavailableReferenceImageNames}
            rendersSleepDisplay={rendersSleepDisplay}
          />

          <details
            open={optionsOpen}
            onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
            className="group min-w-0"
          >
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between rounded-lg border border-port-border px-3 py-2 text-sm font-medium text-gray-300 hover:bg-port-border/30 lg:hidden">
              Options
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-4 lg:mt-0 @3xl/video-form:grid-cols-2">
              <section aria-label="Prompt styling and reference media" className="min-w-0 space-y-3">
                {!runwayPerformance && (
                  <VideoGenPromptStylePanel
                    promptFields={promptFields}
                    negativePromptSupported={gates.negativePromptSupported}
                    enhancePromptBudget={gates.enhancePromptBudget}
                    mode={mode}
                    modelId={model.modelId}
                  />
                )}
                <VideoGenSourceInputsPanel
                  lane={lane}
                  model={model}
                  sampler={sampler}
                  frames={frames}
                  keyframes={keyframes}
                  extend={extend}
                  audio={audio}
                  ic={ic}
                  references={references}
                  fal={fal}
                  runway={runway}
                  higgsfield={higgsfield}
                  google={google}
                  visibleHistory={history.visibleHistory}
                  rendersOffMachine={rendersOffMachine}
                  onBrowse={(kind, index) => setGalleryPicker({ kind, index })}
                  weights={weights}
                />
              </section>
              <VideoGenRenderSettingsPanel
                lane={lane}
                providers={{ grok, fal, runway, higgsfield, google, reactor }}
                model={model}
                sampler={sampler}
                promptFields={promptFields}
                keyframesActive={keyframes.keyframesActive}
                weights={weights}
                catalog={{ models, modelContextRequest, refreshModelContext }}
                loraLibrary={loraLibrary}
                remoteTarget={remoteTarget}
                remoteUnsupportedInputs={gates.remoteUnsupportedInputs}
                rendersOffMachine={rendersOffMachine}
                backendDisclosures={backendDisclosures}
                systemMemoryGb={modelContext?.systemMemoryGb}
                runwayCatalog={runwayCatalog}
                reactorContinuableClips={reactorContinuableClips}
                displaySleep={{ canSleepDisplay, displaySleepEnabled, setDisplaySleepOverride }}
                generating={run.generating}
                onOpenSettings={openSettings}
              />
            </div>
          </details>
        </div>

      </form>

      <RenderStatusCard
        generating={run.generating}
        phase={run.phase}
        progressPct={run.progressPct}
        statusMsg={run.statusMsg}
        error={run.error}
        startedAt={run.renderStartedAt}
        sleepsDisplay={rendersSleepDisplay}
        remote={rendersOffMachine}
      />

      <MediaJobsQueue kind="video" />
      <MediaJobsQueue kind="video-upscale" allowClearFailed />

      <VideoGenGallery
        {...history.gallery}
        onRemix={remix.handleRemixVideo}
        onContinue={remix.handleContinueVideo}
        finishTargetFor={remix.resolveFinishTarget}
        onFinish={remix.handleFinishVideo}
      />

      <MediaPreview
        preview={history.preview}
        setPreview={history.setPreview}
        items={history.previewItems}
        annotations={history.annotations}
        updateAnnotation={history.updateAnnotation}
        onPromptSaved={history.handlePromptSaved}
        onContinue={remix.handleContinue}
        onRemix={(item) => item?.raw && remix.handleRemixVideo(item.raw)}
        onTrimmed={history.handleTrimmed}
        onDelete={history.handleDeleteHistory}
        onToggleHidden={history.handleToggleHistoryHidden}
      />

      <GalleryImagePicker
        open={!!galleryPicker}
        onClose={() => setGalleryPicker(null)}
        onSelect={handleGalleryPick}
      />

      <VideoUpscaleDrawer
        item={history.upscaleItem}
        onClose={() => history.setUpscaleItem(null)}
        onUpscaled={history.handleUpscaled}
      />

      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings" size="lg">
        <ImageGenTab />
      </Drawer>

      <VideoGenEpisodeDrawer episode={episode} onQueued={history.refreshHistory} />

      <RuntimeInstallModal
        open={byov.installModalOpen}
        runtime={byov.byovRuntime}
        label={byov.byovStatus?.label}
        streamMethod="POST"
        onClose={() => byov.setInstallModalOpen(false)}
        onComplete={() => {
          byov.refreshByovStatus();
          // The capability probe decorates the model list, and the install
          // also moves python health. Refresh both after install/repair so
          // H3's LoRA picker and warning react without a manual page reload.
          refreshStatus({ fresh: true });
          refreshModelContext();
        }}
      />
    </div>
  );
}
