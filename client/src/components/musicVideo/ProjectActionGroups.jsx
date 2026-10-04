import { useState } from 'react';
import { Film, Music, Activity, Image as ImageIcon, Video, Wand2 } from 'lucide-react';
import { MUSCRIPTOR_MODELS } from '../../lib/muscriptorModels.js';
import { isLayeredComposition, sceneRenderReady, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { compositionDraft, RENDER_STYLES } from './compositionDraft.js';
import { projectServicesSummary } from '../../lib/musicVideoStages.js';

/**
 * The board-level actions the old single toolbar carried, split by the stage
 * that owns them: analyze + MIDI (Setup), AI plan + auto-arrange (Board), the
 * frame/clip generators (Produce) and the final render (Review). The render
 * style select and the render pins are project options, edited in Setup. Each
 * group takes the page's hook slots (`midi`, `videoSettings`, `sceneMedia`,
 * `renderJob`) and the page-owned in-flight flags in `busy`.
 */

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';
const groupCls = 'flex min-w-0 flex-wrap items-center gap-2';

const uniqueCount = (scenes, key) => new Set(scenes.map((scene) => scene[key]).filter(Boolean)).size;
const noAudioOf = (project) => !project.trackId && !project.uploadedAudioFilename;

/** Analyze the beat grid (Setup step 2). */
export function AnalyzeAction({ project, busy, onAnalyze }) {
  const noAudio = noAudioOf(project);
  return (
    <div className={groupCls}>
      <button onClick={onAnalyze} disabled={busy.analyzing || noAudio}
        title={noAudio ? 'Link a track first' : 'Analyze beat grid'}
        className={buttonCls}>
        <Activity size={15} /> {busy.analyzing ? 'Analyzing…' : 'Analyze'}
      </button>
    </div>
  );
}

/** Transcribe the track to MIDI (an advanced audio tool). */
export function MidiAction({ project, midi, midiBound }) {
  const noAudio = noAudioOf(project);
  return (
    <div className={groupCls}>
      {midiBound ? (
        <button onClick={midi.cancel} title="Cancel MIDI transcription"
          className="flex items-center gap-1 bg-port-warning/20 text-port-warning border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0">
          <Activity size={15} className="animate-spin" /> {midi.stageLabel} · Cancel
        </button>
      ) : (
        <>
          <select value={midi.model} onChange={(e) => midi.setModel(e.target.value)}
            disabled={midi.active}
            aria-label="MuScriptor model size"
            title="MuScriptor model size — larger is higher quality but slower and a bigger first-use download"
            className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm capitalize min-h-[44px] sm:min-h-0 disabled:opacity-50">
            {MUSCRIPTOR_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button onClick={() => midi.start(project.id)}
            disabled={midi.active || noAudio}
            title={noAudio
              ? 'Link a track first'
              : `Transcribe the track to MIDI with MuScriptor (${midi.model} model, local — installs automatically on first use)`}
            className={buttonCls}>
            <Music size={15} /> MIDI
          </button>
        </>
      )}
    </div>
  );
}

/** Plan the shots against the analyzed song and spread them by energy. */
export function PlanActions({ project, busy, onPlan, onAutoArrange }) {
  const sceneCount = (project.scenes || []).length;
  // A board that already has shots needs an explicit choice before planning:
  // planning blindly would stack a second full-song plan on top of it.
  const [choosing, setChoosing] = useState(false);
  const choose = (mode) => { setChoosing(false); onPlan(mode); };
  return (
    <div className={groupCls}>
      <button onClick={() => (sceneCount > 0 ? setChoosing(true) : onPlan())} disabled={busy.planning || !project.audioAnalysis}
        title={!project.audioAnalysis ? 'Analyze the track first' : 'AI-plan bounded shots per song section, cut on timed lyrics, phrases and beats'}
        className={buttonCls}>
        <Wand2 size={15} /> {busy.planning ? 'Planning…' : 'AI Plan'}
      </button>
      {choosing && !busy.planning && (
        <div role="group" aria-label="Plan mode" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-400">The board has {sceneCount} shot{sceneCount === 1 ? '' : 's'}.</span>
          <button onClick={() => choose('replace')} className={buttonCls}
            title="Swap the board for a new plan; takes and clips are kept on shots whose time span is reused">
            Replace {sceneCount} shot{sceneCount === 1 ? '' : 's'}
          </button>
          <button onClick={() => choose('append')} className={buttonCls}
            title="Add the planned shots after the existing ones (can overlap them)">
            Add to board
          </button>
          <button onClick={() => setChoosing(false)} className={buttonCls}>Cancel</button>
        </div>
      )}
      <button onClick={onAutoArrange}
        disabled={busy.arranging || !project.audioAnalysis || sceneCount === 0}
        title={!project.audioAnalysis
          ? 'Analyze the track first'
          : sceneCount === 0
            ? 'Add scenes first'
            : 'Distribute scenes across song sections by energy'}
        className={buttonCls}>
        <Wand2 size={15} /> {busy.arranging ? 'Arranging…' : 'Auto-arrange'}
      </button>
    </div>
  );
}

/**
 * The batch generators, with the image and video services they render on (a
 * project option, edited in Setup › Project options; `onEditServices` goes there).
 */
export function GenerationActions({ project, videoSettings, sceneMedia, onEditServices }) {
  const scenes = project.scenes || [];
  const sceneCount = scenes.length;
  // #8985: in a composed render a still needs only its frame and a title card
  // needs neither frame nor clip, so the counts cover the scenes that use them.
  const mode = project.composition?.mode || 'concat';
  const layered = isLayeredComposition(project);
  const codeMode = mode === 'code' || mode === 'eidoverse';
  const frameScenes = scenes.filter((scene) => sceneVisualLayer(scene, { layered }) !== 'card');
  const footageScenes = scenes.filter((scene) => sceneVisualLayer(scene, { layered }) === 'footage');
  const referenceFrameCount = frameScenes.filter((scene) => scene.referenceImageId).length;
  const renderableSceneCount = footageScenes.filter((scene) => scene.videoHistoryId).length;
  const uniqueReferenceFrameCount = uniqueCount(frameScenes, 'referenceImageId');
  const uniqueVideoCount = uniqueCount(footageScenes, 'videoHistoryId');
  const missingFrameCount = frameScenes.length - referenceFrameCount;
  const missingVideoCount = footageScenes.length - renderableSceneCount;
  const footageFramesReady = footageScenes.every((scene) => scene.referenceImageId);
  const generatingFrames = Object.keys(sceneMedia.genScenes).length > 0;
  const generatingVideos = Object.keys(sceneMedia.genVideoScenes).length > 0;
  const footageBlocked = codeMode ? 'This render style draws its own scene and does not generate footage' : '';
  return (
    <div className={groupCls}>
      <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-port-text-muted">
        {projectServicesSummary(project)}
        {onEditServices && (
          <button type="button" onClick={onEditServices} className="min-h-[44px] px-1 text-port-accent sm:min-h-0">Change in Setup</button>
        )}
      </span>
      <button
        onClick={sceneMedia.generateMissingFrames}
        disabled={codeMode || videoSettings.framePinSaving || sceneCount === 0 || missingFrameCount === 0 || generatingFrames}
        title={footageBlocked || (videoSettings.framePinSaving
          ? 'Saving the frame renderer…'
          : (missingFrameCount > 0 ? `Generate ${missingFrameCount} missing reference frame${missingFrameCount === 1 ? '' : 's'}` : 'Every scene has a reference frame'))}
        className={buttonCls}
      >
        <ImageIcon size={15} /> Frames {referenceFrameCount}/{frameScenes.length}
      </button>
      <button
        onClick={sceneMedia.generateMissingVideos}
        disabled={codeMode || videoSettings.saving || footageScenes.length === 0 || missingVideoCount === 0 || !footageFramesReady || generatingVideos || !!videoSettings.videoBlockedReason}
        title={footageBlocked || videoSettings.videoBlockedReason
          || (!footageFramesReady
            ? 'Generate every reference frame first'
            : (missingVideoCount > 0 ? `Generate ${missingVideoCount} missing scene video${missingVideoCount === 1 ? '' : 's'}` : 'Every scene has a video'))}
        className={buttonCls}
      >
        <Video size={15} /> Videos {renderableSceneCount}/{footageScenes.length}
      </button>
      {(uniqueReferenceFrameCount < referenceFrameCount || uniqueVideoCount < renderableSceneCount) && (
        <span
          className="text-[10px] px-2 py-1.5 rounded border border-port-warning/40 bg-port-warning/10 text-port-warning"
          title={`${referenceFrameCount - uniqueReferenceFrameCount} scene${referenceFrameCount - uniqueReferenceFrameCount === 1 ? '' : 's'} reuse a reference frame; ${renderableSceneCount - uniqueVideoCount} reuse a video clip`}
        >
          Repetition: {uniqueReferenceFrameCount} unique frames · {uniqueVideoCount} unique clips
        </span>
      )}
    </div>
  );
}

/** Footage / composed / code-rendered / composition document. */
export function RenderStyleSelect({ project, onRenderStyle }) {
  return (
    <div>
      <label htmlFor="mv-toolbar-render-style" className="sr-only">Render style</label>
      <select id="mv-toolbar-render-style" value={compositionDraft(project).mode}
        onChange={(e) => onRenderStyle?.(e.target.value)}
        className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm min-h-[44px] sm:min-h-0">
        {RENDER_STYLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
  );
}

/** Render the complete video, or cancel the render in flight for this project. */
export function RenderFinalButton({ project, renderJob, readiness }) {
  const scenes = project.scenes || [];
  const sceneCount = scenes.length;
  const mode = project.composition?.mode || 'concat';
  const layered = isLayeredComposition(project);
  const codeMode = mode === 'code';
  const documentMode = mode === 'document';
  const eidoverseMode = mode === 'eidoverse';
  const eidoverseBlocked = !eidoverseMode ? '' : noAudioOf(project) ? 'Link a track first'
    : !(project.audioAnalysis?.durationSec > 0) ? 'Analyze the master song first'
      : !project.composition?.eidoverseScene?.inlineScript ? 'Save an Eidoverse scene in Compose first' : '';
  const readySceneCount = scenes.filter((scene) => sceneRenderReady(scene, { layered })).length;
  const noAudio = noAudioOf(project);
  const codeDuration = Math.max(
    project.audioAnalysis?.durationSec || 0,
    ...scenes.map((scene) => scene.endSec || 0),
    ...(project.lyricCues || []).map((cue) => cue.endSec || cue.startSec || 0),
  );
  const codeReady = codeMode && !noAudio && codeDuration > 0;
  // A composition document seeks the song: it needs the analysis's duration
  // and an attached document; scene media is optional (the document decides).
  const documentBlocked = !documentMode ? '' : noAudio ? 'Link a track first'
    : !(project.audioAnalysis?.durationSec > 0) ? 'Analyze the track first — the document is timed against the song'
      : !project.composition?.document ? 'Start from the template or import a composition document first' : '';

  // Determine the blocker reason for display
  let blockerReason = '';
  if (!readiness?.readyForProduction) {
    blockerReason = 'Approve the current visual guide, timed storyboard and animated proof first';
  } else if (eidoverseMode && eidoverseBlocked) {
    blockerReason = eidoverseBlocked;
  } else if (documentMode && documentBlocked) {
    blockerReason = documentBlocked;
  } else if (codeMode && !codeReady) {
    blockerReason = 'Analyze the song or time a scene before rendering code';
  } else if (sceneCount === 0) {
    blockerReason = 'Add scenes first';
  } else if (readySceneCount !== sceneCount) {
    blockerReason = layered
      ? `${sceneCount - readySceneCount} scene${sceneCount - readySceneCount === 1 ? ' is' : 's are'} not ready — footage needs a video, a still needs a frame and a span, a card needs a span`
      : `Generate videos for all ${sceneCount} scenes first`;
  }

  if (renderJob.active && renderJob.context === project.id) {
    return (
      <button onClick={renderJob.cancel} disabled={renderJob.pending}
        title={renderJob.pending ? 'Preparing render' : 'Cancel render'}
        className="flex items-center gap-1 bg-port-warning/20 text-port-warning border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0">
        <Activity size={15} className="animate-spin" /> {renderJob.pending ? 'Preparing render…' : `${renderJob.progress}% · Cancel`}
      </button>
    );
  }

  const isDisabled = !readiness?.readyForProduction || renderJob.active || (eidoverseMode ? !!eidoverseBlocked : documentMode ? !!documentBlocked : codeMode ? !codeReady : (sceneCount === 0 || readySceneCount !== sceneCount));

  return (
    <div className="space-y-1">
      <button onClick={() => renderJob.start(project.id)} disabled={isDisabled}
        className="flex items-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
        <Film size={15} /> {renderJob.active ? 'Rendering another project…' : 'Render final'}
      </button>
      {isDisabled && blockerReason && (
        <p className="text-xs text-port-text-muted">{blockerReason}</p>
      )}
    </div>
  );
}
