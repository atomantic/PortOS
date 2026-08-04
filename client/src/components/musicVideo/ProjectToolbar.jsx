import { Film, Trash2, Music, Activity, Image as ImageIcon, Video, Wand2, Copy } from 'lucide-react';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow.jsx';
import { MUSCRIPTOR_MODELS } from '../../lib/muscriptorModels.js';
import VideoRenderSettings from './VideoRenderSettings.jsx';

const uniqueCount = (scenes, key) => new Set(scenes.map((scene) => scene[key]).filter(Boolean)).size;

/**
 * The open project's title row + every board-level action: analyze, transcribe
 * MIDI, AI-plan, auto-arrange, the frame/video render pins, the batch
 * frame/clip generators, fork, final render, delete.
 *
 * `midi` / `videoSettings` / `sceneMedia` / `renderJob` are the page's hook
 * slots; `busy` carries the page-owned in-flight flags for the project-level
 * actions it still owns.
 */
export default function ProjectToolbar({
  project, midi, midiBound, videoSettings, sceneMedia, renderJob, busy,
  onAnalyze, onPlan, onAutoArrange, onClone, onDelete,
}) {
  const scenes = project.scenes || [];
  const sceneCount = scenes.length;
  const referenceFrameCount = scenes.filter((scene) => scene.referenceImageId).length;
  const renderableSceneCount = scenes.filter((scene) => scene.videoHistoryId).length;
  const uniqueReferenceFrameCount = uniqueCount(scenes, 'referenceImageId');
  const uniqueVideoCount = uniqueCount(scenes, 'videoHistoryId');
  const missingFrameCount = sceneCount - referenceFrameCount;
  const missingVideoCount = sceneCount - renderableSceneCount;
  const generatingFrames = Object.keys(sceneMedia.genScenes).length > 0;
  const generatingVideos = Object.keys(sceneMedia.genVideoScenes).length > 0;
  const noAudio = !project.trackId && !project.uploadedAudioFilename;
  const nextVersion = (project.version || 1) + 1;
  return (
    <div className="flex items-start justify-between gap-2 flex-wrap">
      <h2 className="text-lg font-semibold shrink-0">{project.name}</h2>
      <div className="min-w-0 flex flex-1 flex-wrap items-center justify-end gap-2">
        <button onClick={onAnalyze} disabled={busy.analyzing || noAudio}
          title={noAudio ? 'Link a track first' : 'Analyze beat grid'}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Activity size={15} /> {busy.analyzing ? 'Analyzing…' : 'Analyze'}
        </button>
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
              className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm capitalize disabled:opacity-50">
              {MUSCRIPTOR_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button onClick={() => midi.start(project.id)}
              disabled={midi.active || noAudio}
              title={noAudio
                ? 'Link a track first'
                : `Transcribe the track to MIDI with MuScriptor (${midi.model} model, local — installs automatically on first use)`}
              className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
              <Music size={15} /> MIDI
            </button>
          </>
        )}
        <button onClick={onPlan} disabled={busy.planning || !project.audioAnalysis}
          title={!project.audioAnalysis ? 'Analyze the track first' : 'AI-propose a scene per song section'}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Wand2 size={15} /> {busy.planning ? 'Planning…' : 'AI Plan'}
        </button>
        <button onClick={onAutoArrange}
          disabled={busy.arranging || !project.audioAnalysis || sceneCount === 0}
          title={!project.audioAnalysis
            ? 'Analyze the track first'
            : sceneCount === 0
              ? 'Add scenes first'
              : 'Distribute scenes across song sections by energy'}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Wand2 size={15} /> {busy.arranging ? 'Arranging…' : 'Auto-arrange'}
        </button>
        <RecordRenderPinRow
          idPrefix="mv-frame-pin"
          label="Frames"
          imageMode={project.imageMode ?? null}
          imageModelId={project.imageModelId ?? null}
          onChange={videoSettings.changeFramePin}
        />
        <VideoRenderSettings videoSettings={videoSettings} generating={generatingVideos} />
        <button
          onClick={sceneMedia.generateMissingFrames}
          disabled={videoSettings.framePinSaving || sceneCount === 0 || missingFrameCount === 0 || generatingFrames}
          title={videoSettings.framePinSaving
            ? 'Saving the frame renderer…'
            : (missingFrameCount > 0 ? `Generate ${missingFrameCount} missing reference frame${missingFrameCount === 1 ? '' : 's'}` : 'Every scene has a reference frame')}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
        >
          <ImageIcon size={15} /> Frames {referenceFrameCount}/{sceneCount}
        </button>
        <button
          onClick={sceneMedia.generateMissingVideos}
          disabled={videoSettings.saving || sceneCount === 0 || missingVideoCount === 0 || referenceFrameCount !== sceneCount || generatingVideos || (videoSettings.audioReactiveSelected && !videoSettings.audioReactiveReady)}
          title={referenceFrameCount !== sceneCount
            ? 'Generate every reference frame first'
            : (missingVideoCount > 0 ? `Generate ${missingVideoCount} missing scene video${missingVideoCount === 1 ? '' : 's'}` : 'Every scene has a video')}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
        >
          <Video size={15} /> Videos {renderableSceneCount}/{sceneCount}
        </button>
        {(uniqueReferenceFrameCount < referenceFrameCount || uniqueVideoCount < renderableSceneCount) && (
          <span
            className="text-[10px] px-2 py-1.5 rounded border border-port-warning/40 bg-port-warning/10 text-port-warning"
            title={`${referenceFrameCount - uniqueReferenceFrameCount} scene${referenceFrameCount - uniqueReferenceFrameCount === 1 ? '' : 's'} reuse a reference frame; ${renderableSceneCount - uniqueVideoCount} reuse a video clip`}
          >
            Repetition: {uniqueReferenceFrameCount} unique frames · {uniqueVideoCount} unique clips
          </span>
        )}
        <button
          onClick={onClone}
          disabled={busy.cloning}
          title={`Create an editable v${nextVersion}; keep scene media attached and clear the final render`}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
        >
          <Copy size={15} /> {busy.cloning ? 'Forking…' : `Fork v${nextVersion}`}
        </button>
        {renderJob.job ? (
          <button onClick={renderJob.cancel} title="Cancel render"
            className="flex items-center gap-1 bg-port-warning/20 text-port-warning border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0">
            <Activity size={15} className="animate-spin" /> {renderJob.progress}% · Cancel
          </button>
        ) : (
          <button onClick={() => renderJob.start(project.id)} disabled={sceneCount === 0 || renderableSceneCount !== sceneCount}
            title={sceneCount === 0
              ? 'Add scenes first'
              : renderableSceneCount !== sceneCount
                ? `Generate videos for all ${sceneCount} scenes first`
                : 'Render the complete music video over the track'}
            className="flex items-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
            <Film size={15} /> Render final
          </button>
        )}
        <button onClick={onDelete} title="Delete project" aria-label="Delete project"
          className="flex items-center gap-1 text-port-error border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
