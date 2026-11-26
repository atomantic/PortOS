import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeft, Loader2, Save } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import UnsavedChangesConfirm from '../components/ui/UnsavedChangesConfirm';
import { VideoTimelineInspector } from '../components/media/VideoTimelineInspector';
import VideoTimelineLibrary from '../components/media/VideoTimelineLibrary';
import { formatPercent, formatTimecode } from '../utils/formatters';
import { canvasAspectRatio, bedAssetId, historySourceDuration, resolvePlaybackLanes, timelineDuration } from '../lib/videoTimelineModel';
import VideoTimelineWorkspace from './VideoTimelineWorkspace';
import { useTimelineProjectData } from './useTimelineProjectData';
import { useTimelineRenderJob } from './useTimelineRenderJob';

const desktopTimelineLayout = () => (
  typeof window === 'undefined' || window.matchMedia('(min-width: 64rem)').matches
);

export default function VideoTimelineEditor() {
  const { projectId } = useParams();
  return <TimelineProjectEditor key={projectId} projectId={projectId} />;
}

function TimelineProjectEditor({ projectId }) {
  const navigate = useNavigate();
  const {
    project, loading, error, lanes, selection, selected, metaFor, library,
    setSelection, updateLanes, patchLane, removeFromLane, nameDraft, setNameDraft, renameProject,
    isSegmentMissing, isOverlayMissing, isBedMissing, save,
  } = useTimelineProjectData(projectId);
  const { saveError, savePending, routeGuard, retrySave, discardAndExit, flushForRender } = save;
  const { segments, overlays, audio } = lanes;
  const { handleRender, renderJobId, renderProgress } = useTimelineRenderJob({
    projectId, hasSegments: segments.length > 0, flushForRender, navigate,
  });
  const [showLibrary, setShowLibrary] = useState(desktopTimelineLayout);

  // Placement callbacks in the library read the live playhead without
  // subscribing the whole editor to the preview's animation-frame state.
  const playheadRef = useRef(0);
  // Real lengths the browser measured for the beds' audio files, keyed by asset
  // identity (`music/<file>`). The preview resolves each placement against its
  // file's length exactly as the export's probe does; an asset with no entry
  // (metadata not loaded yet, or the load failed) keeps its authored span.
  const [bedDurations, setBedDurations] = useState({});

  // What the export will actually render: the authored lanes resolved against
  // the history clips' real lengths and the beds' measured file lengths, by the
  // same rules `resolveTimeline` applies server-side. Playback, block lengths,
  // fades and overlay timing all read THESE; the inspector and the save path
  // keep reading the authored `lanes`, so nothing probe-derived is persisted.
  const playback = useMemo(() => resolvePlaybackLanes(lanes, {
    sourceDurationFor: (clipId) => historySourceDuration(metaFor(clipId)),
    bedDurationFor: (track) => bedDurations[bedAssetId(track)] ?? null,
  }), [lanes, metaFor, bedDurations]);
  const playSegments = playback.segments;
  const playTracks = playback.audio.tracks;

  const total = useMemo(() => timelineDuration(playSegments), [playSegments]);
  const canvasAspect = useMemo(
    () => canvasAspectRatio(segments, metaFor),
    [segments, metaFor],
  );

  // BedAudio reports a file's measured length here. Identical reports bail out
  // so a re-fired `loadedmetadata` doesn't re-derive the playback lanes.
  const reportBedDuration = useCallback((assetId, seconds) => {
    setBedDurations((prev) => (prev[assetId] === seconds ? prev : { ...prev, [assetId]: seconds }));
  }, []);
  // Forget a file's length once no bed uses it: a removed bed's measurement must
  // not resolve a later placement before that placement has loaded its own.
  useEffect(() => {
    const used = new Set(audio.tracks.map(bedAssetId));
    setBedDurations((prev) => {
      const stale = Object.keys(prev).filter((id) => !used.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [audio.tracks]);

  const ready = !loading && !error && !!project;
  // Keep the workspace's clock and zoom mounted through same-project reloads.
  return (
    <>
      {loading && (
        <PageSkeleton
          label="Loading timeline project"
          headerRowClass="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-port-border"
          titleWidthClass="w-56"
          cards={3}
          sidebar={false}
        />
      )}
      {!loading && !ready && (
        <div className="text-center py-12">
          <p className="text-port-error mb-3">{error || 'Project not found'}</p>
          <button
            type="button"
            onClick={() => navigate('/media/timeline')}
            className="px-3 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-md"
          >
            Back to projects
          </button>
        </div>
      )}
      <div className={ready ? 'space-y-3' : 'hidden'}>
        {ready && (
          <>
            {(saveError || routeGuard.blocked) && (
              <div role="status" aria-label="Timeline save status" className="flex items-center gap-2 text-sm text-port-warning">
                <span>{saveError || 'Saving timeline changes before leaving…'}</span>
                <button type="button" onClick={retrySave} disabled={savePending} className="px-3 py-2 border border-port-border rounded disabled:opacity-50">
                  {savePending ? 'Saving…' : 'Retry save'}
                </button>
              </div>
            )}
            <UnsavedChangesConfirm
              guard={routeGuard}
              when={!savePending}
              question="Discard your unsaved timeline changes?"
              label="Discard unsaved timeline changes"
              onDiscard={discardAndExit}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-port-border">
              <div className="flex items-center gap-2 flex-1 min-w-[120px]">
                <button
                  type="button"
                  onClick={() => navigate('/media/timeline')}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white"
                  title="Back to projects" aria-label="Back to projects"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  aria-label="Project name"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={(e) => renameProject(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent text-white font-medium text-lg focus:outline-none focus:bg-port-card focus:px-2 rounded transition-all"
                />
                <span className="text-xs text-gray-500 hidden sm:inline truncate">
                  {segments.length} segments · {overlays.length} overlays · {audio.tracks.length} beds · {formatTimecode(total)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowLibrary((v) => !v)}
                  aria-expanded={showLibrary}
                  aria-controls="timeline-library"
                  className="px-2 py-1.5 text-xs text-gray-400 hover:text-white border border-port-border rounded-md"
                >
                  {showLibrary ? 'Hide library' : 'Show library'}
                </button>
                <button
                  type="button"
                  onClick={handleRender}
                  disabled={segments.length === 0 || !!renderJobId}
                  className="flex items-center gap-2 px-3 py-1.5 bg-port-success hover:bg-port-success/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md"
                >
                  {renderJobId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {renderJobId ? `Rendering ${formatPercent(renderProgress * 100, { decimals: 0 })}` : 'Render'}
                </button>
              </div>
            </div>
          </>
        )}
        <div className={`grid grid-cols-1 ${
          showLibrary ? 'lg:grid-cols-[260px_1fr_240px]' : 'lg:grid-cols-[1fr_240px]'
        } gap-3 min-h-[400px]`}>
          <VideoTimelineWorkspace
            visible={ready}
            lanes={lanes}
            playSegments={playSegments}
            playTracks={playTracks}
            total={total}
            canvasAspect={canvasAspect}
            playheadRef={playheadRef}
            reportBedDuration={reportBedDuration}
            metaFor={metaFor}
            selection={selection}
            setSelection={setSelection}
            removeFromLane={removeFromLane}
            updateLanes={updateLanes}
            isSegmentMissing={isSegmentMissing}
            isOverlayMissing={isOverlayMissing}
            isBedMissing={isBedMissing}
          />

          {/* The library follows the workspace in DOM/focus order, then moves
              into the desktop grid's left rail. */}
          {ready && showLibrary && (
            <VideoTimelineLibrary library={library} playheadRef={playheadRef} total={total} />
          )}
          {ready && (
            <VideoTimelineInspector
              selected={selected}
              lane={selection?.lane}
              clipVolume={audio.clipVolume}
              metaFor={metaFor}
              isSegmentMissing={isSegmentMissing}
              patchLane={patchLane}
              removeFromLane={removeFromLane}
              updateLanes={updateLanes}
            />
          )}
        </div>
      </div>
    </>
  );
}
