import { memo, useCallback, useMemo } from 'react';
import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors,
  closestCenter, SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates,
} from '../../lib/dnd/index.js';
import { FloatingLane, TimelineBlock } from './VideoTimelineLanes';

// A timeline block is both the drag handle and the click-to-select target, and
// dnd-kit's default keyboard codes claim Enter as well as Space. Narrowing the
// drag to Space leaves Enter free to select the block, so the two activations
// can't fight over one keystroke (see `TimelineBlock` in
// components/media/VideoTimelineLanes.jsx). Tab stays an end key so tabbing
// away can't strand a drag in flight.
const TIMELINE_KEYBOARD_CODES = {
  start: ['Space'],
  cancel: ['Escape'],
  end: ['Space', 'Tab'],
};

const assetLabel = (entry) => entry.assetFile;

// Only the free-lane playhead markers need animation-frame updates.
const SortableVideoLane = memo(function SortableVideoLane({
  playSegments, metaFor, selectedKey, isSegmentMissing, pxPerSec, selectSegment, removeSegment, updateLanes,
}) {
  // Reordering segments by dragging is the only clip-reorder path on this page,
  // so the KeyboardSensor is what makes the timeline orderable without a mouse.
  // A segment block is its own drag source inside the horizontally scrolling
  // lane, so it cannot take `touch-action: none` without losing touch panning;
  // touch instead picks a block up on a long press, and a swipe still scrolls.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: TIMELINE_KEYBOARD_CODES,
    }),
  );

  const onDragEnd = useCallback(({ active, over }) => {
    if (!over || active.id === over.id) return;
    updateLanes((prev) => {
      const oldIdx = prev.segments.findIndex((s) => s._key === active.id);
      const newIdx = prev.segments.findIndex((s) => s._key === over.id);
      if (oldIdx === -1 || newIdx === -1) return prev;
      return { ...prev, segments: arrayMove(prev.segments, oldIdx, newIdx) };
    });
  }, [updateLanes]);

  const segmentKeys = useMemo(() => playSegments.map((s) => s._key), [playSegments]);

  // A segment's _key is a generated id, so dnd-kit's stock "draggable item N"
  // announcements say nothing a listener can act on. Positions are what the
  // user is actually rearranging, so announce those.
  const timelineAccessibility = useMemo(() => {
    const positionOf = (id) => segmentKeys.indexOf(id) + 1;
    const total = segmentKeys.length;
    return {
      announcements: {
        onDragStart: ({ active }) => `Picked up clip ${positionOf(active.id)} of ${total}. Use the left and right arrow keys to move it, Space to drop it, or Escape to cancel.`,
        onDragOver: ({ active, over }) => (over
          ? `Clip ${positionOf(active.id)} is over position ${positionOf(over.id)} of ${total}.`
          : `Clip ${positionOf(active.id)} is outside the timeline.`),
        onDragEnd: ({ active, over }) => (over
          ? `Dropped clip in position ${positionOf(over.id)} of ${total}.`
          : `Clip ${positionOf(active.id)} was dropped outside the timeline and did not move.`),
        onDragCancel: ({ active }) => `Cancelled moving clip ${positionOf(active.id)}. It returned to its original position.`,
      },
      screenReaderInstructions: {
        draggable: 'To reorder this clip, press Space. While moving, use the left and right arrow keys to change its position, then press Space to drop it, or Escape to cancel. Press Enter to select the clip and edit it in the inspector.',
      },
    };
  }, [segmentKeys]);

  return (
    <>
      <div className="text-[9px] uppercase tracking-wide text-gray-600 px-0.5">Video</div>
      {playSegments.length === 0 ? (
        <div className="text-[10px] text-gray-600 pl-2 py-2">Add a clip or a still from the library</div>
      ) : (
        <DndContext
          sensors={sensors}
          accessibility={timelineAccessibility}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={segmentKeys} strategy={horizontalListSortingStrategy}>
            <div className="flex gap-1 items-stretch min-w-min py-1">
              {playSegments.map((segment) => (
                <TimelineBlock
                  key={segment._key}
                  clip={segment}
                  clipMeta={segment.type === 'clip' ? metaFor(segment.clipId) : null}
                  isSelected={segment._key === selectedKey}
                  isMissing={isSegmentMissing(segment)}
                  pxPerSec={pxPerSec}
                  onSelect={selectSegment}
                  onRemove={removeSegment}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  );
});

export default function VideoTimelineTracks({
  playSegments, overlays, playTracks, selection, setSelection, removeFromLane, updateLanes,
  metaFor, isSegmentMissing, isOverlayMissing, isBedMissing, total, pxPerSec, playheadSec,
}) {
  const selectSegment = useCallback((key) => setSelection({ lane: 'segment', key }), [setSelection]);
  const removeSegment = useCallback((key) => removeFromLane('segment', key), [removeFromLane]);
  const selectOverlay = useCallback((key) => setSelection({ lane: 'overlay', key }), [setSelection]);
  const removeOverlay = useCallback((key) => removeFromLane('overlay', key), [removeFromLane]);
  const selectBed = useCallback((key) => setSelection({ lane: 'audio', key }), [setSelection]);
  const removeBed = useCallback((key) => removeFromLane('audio', key), [removeFromLane]);

  const laneWidth = Math.max(240, total * pxPerSec);

  return (
    <div className="bg-port-card/30 border border-port-border rounded-lg p-2 overflow-x-auto space-y-1">
      {playSegments.length === 0 && overlays.length === 0 && playTracks.length === 0 ? (
        <div className="text-xs text-gray-500 py-6 text-center">
          Drag-drop reorder once you've added clips. Add clips, stills, overlays and audio from the library on the left.
        </div>
      ) : (
        /* Every lane renders whenever ANY lane has content. Gating the
           free lanes on the video lane would strand an overlay or bed
           added to an empty project — unselectable and unremovable until
           a video segment happened to be added. */
        <>
          <SortableVideoLane
            playSegments={playSegments}
            metaFor={metaFor}
            selectedKey={selection?.lane === 'segment' ? selection.key : null}
            isSegmentMissing={isSegmentMissing}
            pxPerSec={pxPerSec}
            selectSegment={selectSegment}
            removeSegment={removeSegment}
            updateLanes={updateLanes}
          />
          <FloatingLane
            title="Overlays"
            entries={overlays}
            emptyHint="Add an overlay from the Stills tab"
            tone="bg-port-accent/15 border-port-accent/40"
            labelOf={assetLabel}
            isMissing={isOverlayMissing}
            selectedKey={selection?.lane === 'overlay' ? selection.key : null}
            pxPerSec={pxPerSec}
            width={laneWidth}
            playheadSec={playheadSec}
            onSelect={selectOverlay}
            onRemove={removeOverlay}
          />

          <FloatingLane
            title="Audio"
            entries={playTracks}
            emptyHint="Add a bed from the Audio tab"
            tone="bg-port-success/15 border-port-success/40"
            labelOf={assetLabel}
            isMissing={isBedMissing}
            selectedKey={selection?.lane === 'audio' ? selection.key : null}
            pxPerSec={pxPerSec}
            width={laneWidth}
            playheadSec={playheadSec}
            onSelect={selectBed}
            onRemove={removeBed}
          />
        </>
      )}
    </div>
  );
}
