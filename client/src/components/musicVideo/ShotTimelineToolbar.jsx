import { ChevronLeft, ChevronRight, FilePlus2, Maximize2, Pause, Play, Repeat, Scissors, Zap, ZoomIn, ZoomOut } from 'lucide-react';
import { formatTimecode } from '../../utils/formatters.js';
import { TIMELINE_ZOOM_STEP, timelineSplitAt } from '../../lib/musicVideoTimeline.js';
import { MUSIC_VIDEO_SHOT_GLITCH_LIMIT } from '../../../../server/lib/musicVideo/musicVideoTransitions.js';
import FilePickerButton from '../ui/FilePickerButton.jsx';
import { AUDIO_LAYER_ACCEPT } from './ShotTimelineAudioLayers.jsx';

const zoomButtonCls = 'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text hover:border-port-accent disabled:opacity-40 pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]';

export default function ShotTimelineToolbar({
  playhead, effects, durationSec, cutDrag, draggedCut, onTogglePlay, onReorder, activeIndex, savedShots, onSplitShot,
  effectOptions, onEditShot, onAddAudioLayer, addingLayer, addLayer, zoomBy, zoomTo, atFit, atMax,
}) {
  const { readoutRef, playing, timeRef } = playhead;
  const { playheadShot, playheadGlitches, addEffect, loopOn, loopRange, setLoopOn } = effects;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1">
      {onTogglePlay && (
        <button type="button" className={zoomButtonCls} onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
      )}
      <output ref={readoutRef} aria-label="Playhead time" className="text-sm font-medium tabular-nums text-port-text">{formatTimecode(0)}</output>
      <span className="text-xs tabular-nums text-port-text-muted">/ {formatTimecode(durationSec)}</span>
      {cutDrag && draggedCut && (
        <span role="status" className={`truncate text-xs tabular-nums ${cutDrag.snapped ? 'text-port-success' : 'text-port-text-muted'}`}>
          Cut {formatTimecode(cutDrag.t)} ({cutDrag.t >= draggedCut.t ? '+' : '−'}{Math.abs(cutDrag.t - draggedCut.t).toFixed(2)}s)
        </span>
      )}
      {onReorder && activeIndex >= 0 && (
        <div role="group" aria-label="Move shot" className="flex items-center gap-1">
          <button type="button" className={zoomButtonCls} onClick={() => onReorder(activeIndex, activeIndex - 1)} disabled={activeIndex === 0}
            aria-label="Move shot earlier" title="Move shot earlier">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button type="button" className={zoomButtonCls} onClick={() => onReorder(activeIndex, activeIndex + 1)} disabled={activeIndex === savedShots.length - 1}
            aria-label="Move shot later" title="Move shot later">
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {onSplitShot && (
        <button type="button" className={zoomButtonCls} onClick={() => { const at = timelineSplitAt(savedShots, timeRef.current); if (at) onSplitShot(at.sceneId, at.atSec); }}
          disabled={!playheadShot} aria-label="Split the shot at the playhead" title="Split the shot at the playhead">
          <Scissors size={14} aria-hidden="true" />
        </button>
      )}
      {effectOptions && onEditShot && (
        <button type="button" className={zoomButtonCls} onClick={() => addEffect()}
          disabled={!playheadShot || playheadGlitches.length >= MUSIC_VIDEO_SHOT_GLITCH_LIMIT}
          aria-label="Add an effect at the playhead" title="Add an effect at the playhead">
          <Zap size={14} aria-hidden="true" />
        </button>
      )}
      {onTogglePlay && effectOptions && (
        <button type="button" className={`${zoomButtonCls} ${loopOn && loopRange ? 'border-port-accent text-port-accent' : ''}`} onClick={() => setLoopOn((on) => !on)}
          aria-pressed={loopOn} aria-label="Loop the selected effect" title="Loop the selected effect while it plays">
          <Repeat size={14} aria-hidden="true" />
        </button>
      )}
      {onAddAudioLayer && (
        <FilePickerButton accept={AUDIO_LAYER_ACCEPT} disabled={addingLayer} className={zoomButtonCls}
          ariaLabel="Add an audio layer at the playhead" title={addingLayer ? 'Adding the audio layer…' : 'Add an audio file as a layer at the playhead'}
          onChange={(event) => addLayer(event.target.files?.[0])}>
          <FilePlus2 size={14} aria-hidden="true" />
        </FilePickerButton>
      )}
      <div role="group" aria-label="Zoom" className="ml-auto flex items-center gap-1">
        <button type="button" className={zoomButtonCls} onClick={() => zoomBy(1 / TIMELINE_ZOOM_STEP)} disabled={atFit} aria-label="Zoom out" title="Zoom out">
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <button type="button" className={zoomButtonCls} onClick={() => zoomTo(null)} disabled={atFit} aria-label="Fit the whole song" title="Fit the whole song">
          <Maximize2 size={14} aria-hidden="true" />
        </button>
        <button type="button" className={zoomButtonCls} onClick={() => zoomBy(TIMELINE_ZOOM_STEP)} disabled={atMax} aria-label="Zoom in" title="Zoom in">
          <ZoomIn size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
