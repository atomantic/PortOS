import { useEffect, useRef, useState } from 'react';
import { formatTimecode } from '../../utils/formatters.js';
import { timelineShotAt } from '../../lib/musicVideoTimeline.js';

// How far inside the right edge the playhead may run before the view follows it.
const FOLLOW_MARGIN_PX = 24;
// After a loop jump, how long the player gets to land before its clock is trusted again.
const LOOP_SETTLE_MS = 400;

function rangePlayback(setPointMessage, setPreviewMessage) {
  let wasPlaying = false;
  let lastPreviewMessage = null;
  let lastPointMessage = null;
  let pendingRange = null;
  return (selected, reading, previewSong, t, isPlaying) => {
    const pointUnavailable = reading?.unknownSongOffset ? 'Choose a preview with known song timing to set points or loop.' : null;
    if (pointUnavailable !== lastPointMessage) {
      lastPointMessage = pointUnavailable;
      setPointMessage(pointUnavailable);
    }
    const message = !selected || pointUnavailable ? null
      : !reading || !previewSong ? 'Open a song preview to loop the range.'
        : selected.start < reading.start || (Number.isFinite(reading.end) && selected.end > reading.end + 0.001)
          ? 'Choose a preview that covers the whole range to loop it.' : null;
    if (message !== lastPreviewMessage) {
      lastPreviewMessage = message;
      setPreviewMessage(message);
    }
    const rangeLoop = selected?.loop && !message && !pointUnavailable ? selected : null;
    const clockTime = reading?.t ?? t;
    const outside = rangeLoop && (clockTime < rangeLoop.start || clockTime >= rangeLoop.end || (reading?.ended && clockTime >= rangeLoop.end - 0.001));
    if (!outside || pendingRange !== rangeLoop || (!isPlaying && !reading?.ended)) pendingRange = null;
    // A completed media element can report ended on the very frame it reaches Out.
    // Rearm as soon as the seek lands inside, even for loops shorter than the effect settle time.
    if (outside && (isPlaying || (reading?.ended && wasPlaying)) && !pendingRange) {
      pendingRange = rangeLoop;
      previewSong(rangeLoop.start, true, true);
    }
    wasPlaying = isPlaying;
    return rangeLoop;
  };
}

export default function useTimelinePlayheadLoop({
  live, scrollerRef,
}) {
  const playheadRef = useRef(null);
  const readoutRef = useRef(null);
  const rulerRef = useRef(null);
  const [onScreenId, setOnScreenId] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [previewMessage, setPreviewMessage] = useState(null);
  const [pointMessage, setPointMessage] = useState(null);
  const loopRef = useRef(null);
  const loopJump = useRef(-Infinity); // never jumped; 0 would read as a jump at clock zero and mute the first loop-back for LOOP_SETTLE_MS
  const timeRef = useRef(0);
  // The playhead follows the player's clock frame by frame, outside React.
  useEffect(() => {
    let handle;
    let drawn = { t: null, px: null };
    const updateRange = rangePlayback(setPointMessage, setPreviewMessage);
    const tick = () => {
      const { pxPerSec: px, shots: list, songClock: clock, durationSec: total, range: selected, onPreview: previewSong } = live.current;
      const reading = clock?.() || null;
      const t = Math.min(Math.max(0, reading?.t ?? timeRef.current), total);
      const isPlaying = !!reading?.playing;
      setPlaying(isPlaying);
      const rangeLoop = updateRange(selected, reading, previewSong, t, isPlaying);
      const moved = t !== drawn.t;
      if (moved || px !== drawn.px) {
        timeRef.current = t;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * px}px)`;
        if (moved && readoutRef.current) readoutRef.current.textContent = formatTimecode(t);
        if (moved && rulerRef.current) {
          rulerRef.current.setAttribute('aria-valuenow', String(Math.round(t)));
          rulerRef.current.setAttribute('aria-valuetext', formatTimecode(t));
        }
        const scroller = scrollerRef.current;
        // The view follows the playhead as it plays, and jumps to it when a seek lands out of view.
        if (moved && scroller && drawn.t != null) {
          const x = t * px - scroller.scrollLeft;
          if (x < 0 || x > scroller.clientWidth - FOLLOW_MARGIN_PX) scroller.scrollLeft = Math.max(0, t * px - scroller.clientWidth * 0.1);
        }
        drawn = { t, px };
        const loop = rangeLoop ? null : loopRef.current;
        // One jump per pass: the player takes a few frames to land, and its clock still reads past the end meanwhile.
        if (loop && reading?.playing && t >= loop.end && performance.now() - loopJump.current > LOOP_SETTLE_MS) {
          loopJump.current = performance.now();
          loop.jump(loop.start);
        }
        const shot = timelineShotAt(list, t);
        const id = shot && t < shot.endSec ? shot.sceneId : null;
        setOnScreenId(id);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);
  return { playheadRef, readoutRef, rulerRef, onScreenId, playing, previewMessage, pointMessage,
    loopRef, timeRef };
}
