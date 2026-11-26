import { FormField } from '../ui/FormField';
import ModelDownloadBadge from '../media/ModelDownloadBadge.jsx';
import { formatDownloadGb } from '../../utils/formatters.js';
import {
  isMiniMaxH3SpeedProfile, DEFAULT_SPEED_PROFILE_ID, speedProfilesForMode, videoChainChunkModes,
  DEFAULT_DRAFT_DECODE_ID, draftDecodeOptionsForModel,
} from '../../lib/videoGenParams.js';
import { isLtx2FamilyRuntime } from '../../lib/runnerFamilies';
import { DEFAULT_VIDEO_STREAMING_MODE, VIDEO_STREAMING_MODE_OPTIONS } from '../../lib/videoStreamingMode.js';

function VideoDecodeFields({
  currentModel, inputCls,
  draftDecode = DEFAULT_DRAFT_DECODE_ID, onDraftDecodeChange, draftDecodeLocked = false,
  streamingMode = DEFAULT_VIDEO_STREAMING_MODE, onStreamingModeChange,
  showStreamingMode = isLtx2FamilyRuntime(currentModel?.runtime),
}) {
  // Preview-fidelity decode (#5423). The option list is server-declared and
  // rides on the model entry, so a model with no draft decoder yields [] and
  // renders NO control rather than a select with one real choice.
  // A model the finish graph names as a DELIVERY target always decodes on its
  // own decoder — `draftDecodeDeclineReason` refuses a draft request there
  // before it even asks which decoder was meant. The caller reads that off the
  // model list (`isDeliveryVideoModel`) and passes it down, so the control shows
  // Full and says why rather than offering a choice the server would decline.
  const draftDecodeOptions = draftDecodeOptionsForModel(currentModel);
  const effectiveDraftDecode = draftDecodeLocked ? DEFAULT_DRAFT_DECODE_ID : draftDecode;
  const activeDraftDecode = draftDecodeOptions.find((o) => o.id === effectiveDraftDecode) || null;

  return (
    <>
      {draftDecodeOptions.length > 0 && (
        <FormField label="Decode" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={activeDraftDecode ? effectiveDraftDecode : DEFAULT_DRAFT_DECODE_ID}
            disabled={draftDecodeLocked}
            onChange={(e) => onDraftDecodeChange?.(e.target.value)}
            className={inputCls}
          >
            {draftDecodeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}{option.sizeLabel ? ` · ${option.sizeLabel}` : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {draftDecodeLocked
              ? `${currentModel?.name || 'This model'} is a delivery model — final and Finish renders always decode on the full decoder.`
              : (
                <>
                  {activeDraftDecode?.description || ''}
                  {activeDraftDecode && activeDraftDecode.id !== DEFAULT_DRAFT_DECODE_ID
                    ? ' Finish and delivery renders always use the full decoder.'
                    : ''}
                </>
              )}
          </p>
        </FormField>
      )}

      {/* Block streaming (#6499) — LTX-2/2.5 MLX only, every other runtime
          ignores the flag by construction. Auto initially streams on a
          tight-memory machine; the render bridge inspects the pinned
          pipeline and this machine's physical RAM, so the client offers no
          per-model capability table for it. */}
      {showStreamingMode && (
        <FormField label="Memory" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={streamingMode}
            onChange={(e) => onStreamingModeChange?.(e.target.value)}
            className={inputCls}
          >
            {VIDEO_STREAMING_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {VIDEO_STREAMING_MODE_OPTIONS.find((o) => o.value === streamingMode)?.description || ''}
          </p>
        </FormField>
      )}
    </>
  );
}

function VideoSpeedAdapter({ profile, status, onDownload, onCancel, downloadError }) {
  const estimate = formatDownloadGb(Number((profile.adapter.sizeBytes / 1e9).toFixed(2)));

  return (
    <>
      <p className="mt-1 text-xs text-gray-500">{profile.description}</p>
      <p className="mt-1 text-xs text-gray-500 break-all">{profile.adapter.file} · alpha {profile.adapter.alpha}/rank {profile.adapter.rank} · shifts {profile.videoShift}/{profile.audioShift}. No fallback.</p>
      {onDownload
        ? <ModelDownloadBadge status={status} onDownload={onDownload} onCancel={onCancel} estimateLabel={estimate ? `${estimate} adapter` : undefined} />
        : <p className="text-xs text-gray-500">Manage this adapter download on the Video Gen page.</p>}
      {status?.cached && onDownload && (
        <button
          type="button"
          onClick={onDownload}
          className="pointer-coarse:min-h-11 rounded-lg border border-port-border px-3 py-2 text-xs text-port-accent hover:bg-port-border/50 focus-visible:outline focus-visible:outline-port-accent"
        >
          Download adapter again
        </button>
      )}
      {downloadError && <p role="alert" className="text-xs text-port-error">{downloadError}</p>}
    </>
  );
}

// A speed profile applies to a chain only when every chunk can use it.
function getSpeedProfiles({ currentModel, mode, chainingActive, contextFrames, width, height, speedProfileId, samplerLocked }) {
  const modes = videoChainChunkModes({ model: currentModel, mode, chaining: chainingActive, contextFrames });
  const h3Profiles = (currentModel?.speedProfiles || []).filter(isMiniMaxH3SpeedProfile);
  const speedProfiles = speedProfilesForMode(currentModel, modes).filter((profile) => (
    !isMiniMaxH3SpeedProfile(profile) || (!chainingActive && (width == null || height == null
      || profile.canvases.some(([w, h]) => Number(width) === w && Number(height) === h)))
  ));
  const visibleSpeedProfiles = [...speedProfiles, ...h3Profiles.filter((profile) => !speedProfiles.includes(profile))];
  const showSpeedProfiles = h3Profiles.length > 0 || (!samplerLocked && speedProfiles.length > 0);
  const activeSpeedProfile = showSpeedProfiles
    ? speedProfiles.find((profile) => profile.id === speedProfileId) || null
    : null;
  const incompatibleH3Profile = activeSpeedProfile ? null : h3Profiles.find((profile) => profile.id === speedProfileId);

  return { speedProfiles, visibleSpeedProfiles, showSpeedProfiles, activeSpeedProfile, incompatibleH3Profile };
}

export default function VideoSpeedDecodeFields({
  mode, currentModel, fieldId, inputCls,
  chainingActive, contextFrames,
  steps, onStepsChange,
  guidanceScale, onGuidanceScaleChange,
  speedProfileId = DEFAULT_SPEED_PROFILE_ID, onSpeedProfileChange,
  speedProfileStatus, onSpeedProfileDownload, onCancelSpeedProfileDownload, speedProfileDownloadError,
  width, height,
  draftDecode, onDraftDecodeChange, draftDecodeLocked,
  streamingMode, onStreamingModeChange, showStreamingMode,
}) {
  const { steps: modelSteps, guidance: modelGuidance, samplerNote } = currentModel ?? {};
  const samplerLocked = currentModel?.samplerLocked === true;
  const { speedProfiles, visibleSpeedProfiles, showSpeedProfiles, activeSpeedProfile, incompatibleH3Profile } = getSpeedProfiles({
    currentModel, mode, chainingActive, contextFrames, width, height, speedProfileId, samplerLocked,
  });
  // A profile drives steps AND CFG together, exactly as a samplerLocked model
  // does — leaving either editable would let the user half-override a
  // validated schedule and get neither its speed nor its quality.
  const samplerDriven = samplerLocked || !!activeSpeedProfile;
  const samplerDrivenTitle = activeSpeedProfile
    ? `The ${activeSpeedProfile.name} profile sets the complete sampler schedule.`
    : samplerLocked
      ? 'This model locks its stock sampler settings.'
      : undefined;

  return (
    <>
      {incompatibleH3Profile && (
        <p role="alert" className="col-span-2 sm:col-span-3 text-xs text-port-warning">
          The selected speed profile requires a single text/image clip at {incompatibleH3Profile.canvases.map(([w, h]) => `${w}×${h}`).join(', ')}. Change the mode/canvas or select Quality before rendering.
        </p>
      )}
      <VideoDecodeFields
        currentModel={currentModel} inputCls={inputCls}
        draftDecode={draftDecode} onDraftDecodeChange={onDraftDecodeChange} draftDecodeLocked={draftDecodeLocked}
        streamingMode={streamingMode} onStreamingModeChange={onStreamingModeChange} showStreamingMode={showStreamingMode}
      />
      {showSpeedProfiles && (
        <FormField label="Speed" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            id={fieldId('video-speed-profile')}
            value={activeSpeedProfile || incompatibleH3Profile ? speedProfileId : DEFAULT_SPEED_PROFILE_ID}
            onChange={(e) => onSpeedProfileChange(e.target.value)}
            className={inputCls}
          >
            <option value={DEFAULT_SPEED_PROFILE_ID}>Quality · default</option>
            {visibleSpeedProfiles.map((p) => (
              <option key={p.id} value={p.id} disabled={!speedProfiles.includes(p)}>
                {p.name}{p.speedupLabel ? ` · ${p.speedupLabel}` : ''}
              </option>
            ))}
          </select>
          {isMiniMaxH3SpeedProfile(activeSpeedProfile) && (
            <VideoSpeedAdapter
              profile={activeSpeedProfile} status={speedProfileStatus} onDownload={onSpeedProfileDownload}
              onCancel={onCancelSpeedProfileDownload} downloadError={speedProfileDownloadError}
            />
          )}
        </FormField>
      )}

      <FormField
        label={<>Steps {modelSteps && `(default: ${modelSteps})`}</>}
        labelClassName="block text-xs font-medium text-gray-400 mb-1"
      >
        <input
          type="number" min={1} max={150}
          value={activeSpeedProfile ? '' : steps}
          onChange={(e) => onStepsChange(e.target.value)}
          disabled={samplerDriven}
          title={samplerDrivenTitle}
          placeholder={String(activeSpeedProfile?.steps ?? modelSteps ?? 25)}
          className={inputCls}
        />
      </FormField>

      <FormField
        label={<>CFG Scale {modelGuidance != null && `(default: ${modelGuidance})`}</>}
        labelClassName="block text-xs font-medium text-gray-400 mb-1"
      >
        <input
          type="number" min={0} max={20} step={0.5}
          value={activeSpeedProfile ? '' : guidanceScale}
          onChange={(e) => onGuidanceScaleChange(e.target.value)}
          disabled={samplerDriven}
          title={samplerDrivenTitle}
          placeholder={String(activeSpeedProfile?.guidance ?? modelGuidance ?? 3.0)}
          className={inputCls}
        />
      </FormField>

      {samplerLocked && (
        <p className="col-span-2 sm:col-span-3 text-[10px] text-port-accent leading-snug">
          {samplerNote
            || `Lightning keeps its validated ${modelSteps}-step sampler, CFG ${modelGuidance}, and model-specific schedule locked.`}
        </p>
      )}

      {activeSpeedProfile && (
        <p className="col-span-2 sm:col-span-3 text-[10px] text-port-accent leading-snug">
          {activeSpeedProfile.description}
          {' '}Steps and CFG follow the profile ({activeSpeedProfile.steps}
          {activeSpeedProfile.stage2Steps != null ? `+${activeSpeedProfile.stage2Steps}` : ''} steps, CFG {activeSpeedProfile.guidance}).
          {' '}If a lever it needs is missing on this machine, the render still runs and says so rather than claiming the speed-up.
        </p>
      )}
    </>
  );
}
