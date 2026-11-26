import { useEffect, useMemo, useRef, useState } from 'react';
import { clamp } from '../utils/formatters';
import { findSegmentAt, audioTrackStateAt, segmentVolumeAt } from '../lib/videoTimelineModel';

export function useTimelinePlayback({ playSegments, playTracks, clipVolume, total, metaFor, playheadRef, visible }) {
  const [t, setT] = useState(0); // project-time in seconds
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  const videoRef = useRef(null);
  const lastSrcRef = useRef('');
  useEffect(() => {
    // Reloads temporarily remove the video element while the project clock stays live.
    if (!visible) lastSrcRef.current = '';
  }, [visible]);
  // The video.onloadedmetadata callback fires async after a src swap. Reading
  // `playing` directly inside it captures the value at swap time — if the
  // user pauses while metadata loads, the handler would still autoplay. A
  // ref tracks the committed play/pause state for the metadata handler.
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const playSegmentIndexRef = useRef(-1);
  // One <audio> element per bed track, keyed by its client-side _key.
  const bedRefs = useRef(new Map());

  // Clamp the playhead into [0, total] when the timeline duration shrinks
  // (segment removal, tighter trim, etc.). Without this, t can exceed total
  // and findSegmentAt returns a `within` past the last segment's end — the
  // preview seeks to black frames.
  useEffect(() => {
    if (t > total) { setT(total); setPlaying(false); }
  }, [total, t]);

  useEffect(() => { playheadRef.current = t; }, [t, playheadRef]);

  // Playback: keep a single <video> element that follows project-time. On every
  // rAF tick, advance `t` by elapsed wall-time; the sync effects below drive
  // the media elements from it.
  useEffect(() => {
    if (!playing) return;
    let lastTick = performance.now();
    const tick = (now) => {
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    let frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);

  const { index: activeIndex, within: activeWithin } = useMemo(
    () => (playSegments.length > 0 ? findSegmentAt(playSegments, t) : { index: -1, within: 0 }),
    [playSegments, t],
  );
  const activeSegment = activeIndex >= 0 ? playSegments[activeIndex] : null;

  // Sync the <video> element to project-time whenever the active segment or the
  // scrub position changes. A still segment has no video source — the effect
  // parks the element so the <img> below takes over the frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!visible || !video || !activeSegment) return;
    if (activeSegment.type === 'still') {
      lastSrcRef.current = '';
      playSegmentIndexRef.current = activeIndex;
      video.pause();
      return;
    }
    const meta = metaFor(activeSegment.clipId);
    if (!meta) return;
    const src = `/data/videos/${meta.filename}`;
    const wantTime = activeSegment.inSec + activeWithin;
    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      video.src = src;
      // Wait for metadata before seeking — seek-before-load silently no-ops
      // and the user sees frame 0 of the clip instead of `inSec + within`.
      video.onloadedmetadata = () => {
        // Rapid scrubbing across segment boundaries reassigns src (and this
        // handler) before the prior metadata load fires; bail if this src is
        // no longer the one we want so a stale load can't seek the new clip.
        if (videoRef.current !== video || lastSrcRef.current !== src) return;
        video.currentTime = wantTime;
        if (playingRef.current) video.play().catch(() => {});
      };
    } else if (activeIndex !== playSegmentIndexRef.current) {
      video.currentTime = wantTime;
    } else if (!playing && Math.abs(video.currentTime - wantTime) > 0.05) {
      // Scrubbing while paused: the rAF loop only runs while playing, so we
      // drive the element manually. During playback the element advances on its
      // own — re-seeking every frame would cause buffering stutter.
      video.currentTime = wantTime;
    }
    playSegmentIndexRef.current = activeIndex;
  }, [activeSegment, activeIndex, activeWithin, metaFor, playing, visible]);

  // Pause/play the underlying element in lockstep with `playing`. A still
  // segment holds no video, so there is nothing to start.
  useEffect(() => {
    const video = videoRef.current;
    if (!visible || !video) return;
    if (playing && activeSegment?.type !== 'still') video.play().catch(() => {});
    else video.pause();
  }, [playing, activeSegment?.type, visible]);

  // The clip lane's own audio level — clipVolume × the segment's volume × its
  // fade ramp, the same product the export builds into each segment's chain.
  // Without this the user ducks the dialogue, hears no change while auditioning,
  // and gets a different mix out of the render.
  const activeClipVolume = segmentVolumeAt(activeSegment, clipVolume, activeWithin);
  useEffect(() => {
    const video = videoRef.current;
    if (!visible || !video) return;
    if (video.muted !== muted) video.muted = muted;
    // Only correct real drift — a media property write per frame queues a
    // `volumechange` event per frame for no audible gain.
    if (Math.abs(video.volume - activeClipVolume) > 0.01) video.volume = activeClipVolume;
  }, [muted, activeClipVolume, visible]);

  // Drive the bed <audio> elements from the same playhead the export mixes
  // against, so what the user hears while scrubbing is what amix will produce.
  useEffect(() => {
    for (const track of playTracks) {
      const el = bedRefs.current.get(track._key);
      if (!el) continue;
      const state = audioTrackStateAt(track, t);
      if (el.muted !== muted) el.muted = muted;
      // clipVolume scales the video lane's OWN audio, not the bed — the export
      // applies it inside each segment's chain, before amix.
      const want = clamp(state.volume, 0, 1);
      if (Math.abs(el.volume - want) > 0.01) el.volume = want;
      if (!state.active) {
        if (!el.paused) el.pause();
        continue;
      }
      // Re-seeking every tick causes audible stutter; only correct real drift.
      if (Math.abs(el.currentTime - state.sourceTime) > 0.25) el.currentTime = state.sourceTime;
      if (playing && el.paused) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    }
  }, [playTracks, t, playing, muted]);

  // Stop every bed when the editor unmounts — a detached <audio> that was
  // playing keeps producing sound in some browsers.
  useEffect(() => {
    const els = bedRefs.current;
    return () => { for (const el of els.values()) el?.pause(); };
  }, []);

  const seek = (seconds) => { setPlaying(false); setT(seconds); };
  const togglePlaying = () => setPlaying((current) => !current);
  const toggleMuted = () => setMuted((current) => !current);

  return {
    t, playing, muted, seek, togglePlaying, toggleMuted,
    videoRef, bedRegistry: bedRefs.current, activeSegment, activeWithin,
  };
}
