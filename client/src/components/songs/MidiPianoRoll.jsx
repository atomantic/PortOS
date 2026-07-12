import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { midiNoteName, isBlackKey } from '../../lib/pianoKeyboard';
import { chordNoteNames } from '../../lib/midiChords';
import { roundRect, layerColor } from '../../lib/canvasRoll.js';
import { formatTimecode } from '../../utils/formatters';
import useCanvasDprSize from '../../hooks/useCanvasDprSize.js';

// DAW-style horizontal piano-roll for inspecting a transcribed `.mid` file
// (time × pitch grid) — NOT the Synthesia falling-note <PianoRoll>, which is
// score-playback pedagogy. Presentational: gets the parsed view-model from
// midiNotes.js via props and only draws + handles pointer/keyboard input.
//
// The canvas is virtualized — it stays the container's width and pans by a
// scroll offset (a full-duration canvas at high zoom would blow past browser
// canvas size limits). Pan/scrub state lives in refs and redraws directly so
// dragging never churns React renders; hover state holds only the hovered
// note/chord IDENTITY (it drives the highlight repaint) while the tooltip's
// x/y position is mutated straight onto the DOM node — a mousemove within one
// note repaints nothing.

const GUTTER_W = 44;   // left pitch gutter
const RULER_H = 18;    // top time ruler
const CHORD_H = 20;    // chord lane strip (when shown)
const BG = '#0c0c0e';
const GUTTER_BG = '#131316';
const ACCENT = '#3b82f6';
const GRID_LINE = 'rgba(255,255,255,0.05)';
const C_LINE = 'rgba(255,255,255,0.14)';
const TEXT_DIM = '#71717a';
const NOTE_RADIUS = 2;
const TOOLTIP_W = 170; // clamp so the tooltip never overflows the right edge

// Zoom is a multiplier over fit-to-width (1 = whole file visible). ZOOM_STEP
// is the shared discrete step for toolbar buttons and +/- keys — wheel/pinch
// use finer continuous factors.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 64;
export const ZOOM_STEP = 1.5;
export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// Ruler tick step that keeps labels ≥ ~70px apart at the current zoom.
const tickStep = (pps) => {
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  return steps.find((s) => s * pps >= 70) || 300;
};

// First index in the start-sorted note list with startSec >= t. Subtracting
// the file's longest note duration from a window edge before searching gives
// the earliest index that can still overlap that edge — O(log n) instead of
// skip-scanning from note 0, which matters once the rAF playback loop makes
// drawing a 60fps hot path.
const lowerBound = (notes, t) => {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].startSec < t) lo = mid + 1; else hi = mid;
  }
  return lo;
};

const tooltipStyle = (x, y, width) => ({
  left: `${Math.min(x + 10, Math.max(0, width - TOOLTIP_W))}px`,
  top: `${Math.max(0, y - 24)}px`,
});

/**
 * @param {object} props
 * @param {object} props.data — view-model from parseMidiFile.
 * @param {Array} props.chords — windows from detectChordWindows.
 * @param {boolean} props.showChords
 * @param {number} props.zoom — fit-relative multiplier (MIN_ZOOM..MAX_ZOOM).
 * @param {(next:number)=>void} props.onZoomChange — wheel/pinch zoom.
 * @param {number} props.height — total canvas height in px.
 * @param {boolean} [props.playing] — drives the rAF playhead loop (synth preview).
 * @param {()=>number} [props.getPosition] — live playback position in seconds
 *   (stable reference; reads the MIDI player's position()).
 * @param {(sec:number)=>void} [props.onSeek] — playhead moved by tap/arrow keys.
 * @param {()=>void} [props.onTogglePlay] — Space pressed (play/pause).
 */
export default function MidiPianoRoll({
  data, chords, showChords, zoom, onZoomChange, height,
  playing = false, getPosition, onSeek, onTogglePlay,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const scrollSecRef = useRef(0);
  const playheadSecRef = useRef(0);
  const pointersRef = useRef(new Map()); // pointerId → { x, y, moved }
  const pinchRef = useRef(null);         // { startDist, startZoom }
  const tooltipRef = useRef(null);
  const tooltipPosRef = useRef({ x: 0, y: 0 });
  // Identity only ({ kind, note } | { kind, chord }) — drives the highlight
  // repaint; position updates never touch state.
  const [hover, setHover] = useState(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Latest playback props without making them draw()/effect dependencies —
  // the parent hands fresh closures each render; the rAF loop reads refs.
  const getPositionRef = useRef(getPosition);
  getPositionRef.current = getPosition;
  // Set of midis sounding this frame (null when idle) — written by the rAF
  // playback loop, painted onto the pitch gutter by draw().
  const soundingRef = useRef(null);
  // Whether the view should follow the moving playhead. An explicit user pan
  // (drag / wheel / shift+arrows) turns following off so the loop's page-snap
  // doesn't fight the pan frame-by-frame; it turns back on when the playhead
  // re-enters the view, on a seek, and on play.
  const followRef = useRef(true);

  const duration = Math.max(data?.durationSec || 0, 0.001);
  // Longest note in the file — the lookback window for lowerBound() scans.
  const maxDurSec = useMemo(
    () => (data?.notes || []).reduce((m, n) => Math.max(m, n.durationSec || 0), 0),
    [data],
  );
  const chordLaneH = showChords && chords?.length ? CHORD_H : 0;
  const multiTrack = (data?.tracks?.length || 1) > 1;

  // Pitch rows: pad one semitone each side, widen to at least an octave.
  let lowMidi = Math.max(0, (data?.minMidi ?? 60) - 1);
  let highMidi = Math.min(127, (data?.maxMidi ?? 71) + 1);
  if (highMidi - lowMidi < 11) {
    const pad = Math.ceil((11 - (highMidi - lowMidi)) / 2);
    lowMidi = Math.max(0, lowMidi - pad);
    highMidi = Math.min(127, lowMidi + 11);
  }
  const rowCount = highMidi - lowMidi + 1;

  const geometry = useCallback(() => {
    const width = widthRef.current;
    const gridW = Math.max(1, width - GUTTER_W);
    const fitPps = gridW / duration;
    const pps = fitPps * zoomRef.current;
    const gridTop = RULER_H + chordLaneH;
    const gridH = Math.max(1, height - gridTop);
    const rowH = gridH / rowCount;
    const maxScroll = Math.max(0, duration - gridW / pps);
    return { width, gridW, pps, gridTop, gridH, rowH, maxScroll };
  }, [duration, chordLaneH, height, rowCount]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { width, gridW, pps, gridTop, gridH, rowH, maxScroll } = geometry();
    if (!canvas || !width) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    scrollSecRef.current = Math.min(Math.max(0, scrollSecRef.current), maxScroll);
    const scroll = scrollSecRef.current;
    const viewEnd = scroll + gridW / pps;
    const timeToX = (sec) => GUTTER_W + (sec - scroll) * pps;
    const midiToY = (m) => gridTop + (highMidi - m) * rowH;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    // Horizontal pitch rows — black-key rows tinted, every C stronger.
    for (let m = lowMidi; m <= highMidi; m += 1) {
      const y = midiToY(m);
      if (m % 12 === 0) {
        ctx.fillStyle = C_LINE;
        ctx.fillRect(GUTTER_W, y + rowH, gridW, 1);
      } else if (rowH >= 4) {
        if (isBlackKey(m)) {
          ctx.fillStyle = 'rgba(255,255,255,0.02)';
          ctx.fillRect(GUTTER_W, y, gridW, rowH);
        }
        ctx.fillStyle = GRID_LINE;
        ctx.fillRect(GUTTER_W, y + rowH, gridW, 1);
      }
    }

    // Vertical time grid + ruler labels.
    const step = tickStep(pps);
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (let t = Math.floor(scroll / step) * step; t <= viewEnd; t += step) {
      if (t < 0) continue;
      const x = timeToX(t);
      if (x < GUTTER_W) continue;
      ctx.fillStyle = GRID_LINE;
      ctx.fillRect(x, gridTop, 1, gridH);
      ctx.fillStyle = TEXT_DIM;
      // Sub-second tick steps need the fractional digits or adjacent labels
      // render identically ("0:03 0:03 0:03") right when fine timing matters.
      ctx.fillText(step < 1 ? formatTimecode(t) : formatTimecode(t).replace(/\.\d+$/, ''), x + 3, RULER_H - 6);
    }

    // Chord lane.
    if (chordLaneH) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(GUTTER_W, RULER_H, gridW, chordLaneH);
      (chords || []).forEach((c) => {
        if (c.endSec < scroll || c.startSec > viewEnd) return;
        const x0 = Math.max(GUTTER_W, timeToX(c.startSec));
        const x1 = Math.min(width, timeToX(c.endSec));
        if (x1 - x0 < 2) return;
        const isHover = hover?.kind === 'chord' && hover.chord === c;
        ctx.fillStyle = isHover ? 'rgba(59,130,246,0.25)' : 'rgba(59,130,246,0.10)';
        ctx.fillRect(x0, RULER_H + 1, x1 - x0 - 1, chordLaneH - 2);
        // Sticky-left label, clipped to the window.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, RULER_H, x1 - x0, chordLaneH);
        ctx.clip();
        ctx.fillStyle = isHover ? '#dbeafe' : '#9ca3af';
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(c.label, x0 + 3, RULER_H + chordLaneH - 6);
        ctx.restore();
      });
    }

    // Notes — only those intersecting the visible window, clipped to the grid.
    // The list is sorted by startSec (parseMidiFile), so bail out of the loop
    // at the first note past the right edge.
    const hoverChordMidis = hover?.kind === 'chord' ? new Set(hover.chord.midis) : null;
    const hoverChordSpan = hover?.kind === 'chord' ? hover.chord : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER_W, gridTop, gridW, gridH);
    ctx.clip();
    ctx.textAlign = 'left';
    const notes = data?.notes || [];
    for (let i = lowerBound(notes, scroll - maxDurSec); i < notes.length; i += 1) {
      const n = notes[i];
      if (n.startSec > viewEnd) break;
      const end = n.startSec + n.durationSec;
      if (end < scroll) continue;
      if (n.midi < lowMidi || n.midi > highMidi) continue;
      const x = timeToX(n.startSec);
      const w = Math.max(2, n.durationSec * pps);
      const y = midiToY(n.midi);
      const h = Math.max(2, rowH - 1);
      roundRect(ctx, x, y + 0.5, w, h, NOTE_RADIUS);
      ctx.fillStyle = multiTrack ? layerColor(n.track) : ACCENT;
      ctx.globalAlpha = 0.35 + 0.6 * (n.velocity ?? 0.8);
      ctx.fill();
      const isHoverNote = hover?.kind === 'note' && hover.note.id === n.id;
      const inHoverChord = hoverChordMidis?.has(n.midi)
        && hoverChordSpan && n.startSec < hoverChordSpan.endSec && end > hoverChordSpan.startSec;
      if (isHoverNote || inHoverChord) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // In-bar note name when it fits.
      if (w >= 28 && rowH >= 12) {
        ctx.fillStyle = '#0c0c0e';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(n.name || midiNoteName(n.midi), x + 3, y + h - Math.max(1, (h - 8) / 2));
      }
    }
    ctx.restore();

    // Playhead — scrub position when idle, live audio position while playing
    // (the rAF loop mutates playheadSecRef from getPosition() each frame).
    const px = timeToX(playheadSecRef.current);
    if (px >= GUTTER_W && px <= width) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(px - 1, RULER_H, 2, height - RULER_H);
    }

    // Sounding pitches (playing only) — computed once per frame by the rAF
    // playback loop (null when idle); draw just paints the gutter rows.
    const soundingMidis = soundingRef.current;

    // Pitch gutter on top (opaque, so notes pan "under" it).
    ctx.fillStyle = GUTTER_BG;
    ctx.fillRect(0, gridTop, GUTTER_W, gridH);
    ctx.textAlign = 'right';
    for (let m = lowMidi; m <= highMidi; m += 1) {
      const y = midiToY(m);
      if (soundingMidis?.has(m)) {
        ctx.fillStyle = 'rgba(59,130,246,0.45)';
        ctx.fillRect(0, y, GUTTER_W, Math.max(1, rowH));
      }
      if (m % 12 === 0 && rowH >= 3) {
        ctx.fillStyle = TEXT_DIM;
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(midiNoteName(m), GUTTER_W - 4, y + rowH - 1);
        ctx.fillStyle = C_LINE;
        ctx.fillRect(0, y + rowH, GUTTER_W, 1);
      } else if (rowH >= 7) {
        ctx.fillStyle = isBlackKey(m) ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.10)';
        ctx.fillRect(GUTTER_W - 8, y + 1, 5, Math.max(1, rowH - 2));
      }
    }
    // Scroll indicator along the bottom when zoomed in.
    if (maxScroll > 0) {
      const frac = gridW / (duration * pps);
      const barW = Math.max(24, gridW * frac);
      const barX = GUTTER_W + (scroll / maxScroll) * (gridW - barW);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(barX, height - 3, barW, 2);
    }
  }, [data, chords, chordLaneH, geometry, height, highMidi, lowMidi, hover, multiTrack, duration, maxDurSec]);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  // DPR-aware canvas sizing + redraw on container resize (shared hook).
  const widthRef = useCanvasDprSize(wrapRef, canvasRef, height, drawRef);

  useEffect(() => { draw(); }, [draw, zoom]);

  // Playback rAF loop: while playing, read the live audio position into the
  // playhead ref, page the view to keep it visible, compute the sounding
  // pitch set for the gutter, and repaint — but only when a frame is visually
  // different (playhead pixel, sounding set, or a page turn). At fit zoom the
  // playhead moves well under a pixel per frame, so most frames skip the full
  // canvas repaint. On pause/stop the loop tears down and one static frame
  // pins the playhead where the audio stopped.
  const wasPlayingRef = useRef(false);
  const lastFrameRef = useRef('');
  useEffect(() => {
    const notes = data?.notes || [];
    if (!playing) {
      soundingRef.current = null;
      if (wasPlayingRef.current) {
        wasPlayingRef.current = false;
        playheadSecRef.current = getPositionRef.current?.() ?? 0;
        drawRef.current();
      }
      return undefined;
    }
    wasPlayingRef.current = true;
    lastFrameRef.current = '';
    followRef.current = true; // pressing play re-follows the playhead
    let raf = 0;
    const loop = () => {
      const pos = getPositionRef.current?.() ?? 0;
      playheadSecRef.current = pos;
      // Page-turn follow: when the playhead exits the visible window, snap the
      // view so it re-enters near the left — but only while following (an
      // explicit user pan turns following off until the playhead re-enters).
      const { gridW, pps, maxScroll } = geometry();
      const view = gridW / pps;
      let paged = false;
      const visible = pos >= scrollSecRef.current && pos <= scrollSecRef.current + view;
      if (visible) {
        followRef.current = true;
      } else if (followRef.current) {
        scrollSecRef.current = Math.min(Math.max(0, pos - view * 0.1), maxScroll);
        paged = true;
      }
      // Sounding set — scan only the slice that can overlap the playhead.
      const sounding = new Set();
      for (let i = lowerBound(notes, pos - maxDurSec); i < notes.length; i += 1) {
        const n = notes[i];
        if (n.startSec > pos) break;
        if (pos < n.startSec + n.durationSec) sounding.add(n.midi);
      }
      // Signature = playhead pixel + exact sounding pitches (the set is
      // polyphony-sized, so the sort/join is cheap) — a size+sum digest would
      // miss contrary semitone motion at a sub-pixel playhead step.
      const frame = `${Math.round((pos - scrollSecRef.current) * pps)}:${[...sounding].sort((a, b) => a - b).join(',')}`;
      if (paged || frame !== lastFrameRef.current) {
        lastFrameRef.current = frame;
        soundingRef.current = sounding;
        drawRef.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, geometry, data, maxDurSec]);

  // Coalesce pan-driven repaints to one per animation frame — wheel/pointer
  // events can fire faster than the display presents.
  const rafRef = useRef(0);
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const canvasPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTest = useCallback((x, y) => {
    const { gridW, pps, gridTop, rowH } = geometry();
    const scroll = scrollSecRef.current;
    if (x < GUTTER_W || x > GUTTER_W + gridW) return null;
    const sec = scroll + (x - GUTTER_W) / pps;
    if (chordLaneH && y >= RULER_H && y < RULER_H + chordLaneH) {
      const chord = (chords || []).find((c) => sec >= c.startSec && sec <= c.endSec);
      return chord ? { kind: 'chord', chord } : null;
    }
    if (y < gridTop) return null;
    const midi = highMidi - Math.floor((y - gridTop) / rowH);
    // Iterate back-to-front so the top-drawn (later) note wins the hit; the
    // 2/pps term keeps min-width (2px) bars hittable.
    const notes = data?.notes || [];
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      const n = notes[i];
      if (n.midi !== midi) continue;
      if (sec >= n.startSec && sec <= n.startSec + Math.max(n.durationSec, 2 / pps)) {
        return { kind: 'note', note: n };
      }
    }
    return null;
  }, [chords, chordLaneH, data, geometry, highMidi]);

  // Update tooltip position without re-rendering: stash in a ref and mutate
  // the DOM node directly when it's mounted.
  const moveTooltip = useCallback((x, y) => {
    tooltipPosRef.current = { x, y };
    const el = tooltipRef.current;
    if (el) Object.assign(el.style, tooltipStyle(x, y, widthRef.current || 0));
  }, [widthRef]);

  // Set hover identity only when it actually changed — same note/chord under
  // the cursor returns prev, so React bails out and the canvas doesn't repaint.
  const setHoverIdentity = useCallback((hit) => {
    setHover((prev) => {
      if (!hit && !prev) return prev;
      if (hit && prev && hit.kind === prev.kind
        && (hit.kind === 'note' ? hit.note.id === prev.note.id : hit.chord === prev.chord)) {
        return prev;
      }
      return hit;
    });
  }, []);

  const applyZoomAnchored = useCallback((factor, anchorX) => {
    const { pps } = geometry();
    const next = clampZoom(zoomRef.current * factor);
    if (next === zoomRef.current) return;
    const anchorSec = scrollSecRef.current + (Math.max(anchorX, GUTTER_W) - GUTTER_W) / pps;
    const nextPps = (pps / zoomRef.current) * next;
    // Mutate scroll BEFORE notifying the parent: the zoom prop change triggers
    // the redraw effect, which clamps and paints with the adjusted scroll.
    scrollSecRef.current = anchorSec - (Math.max(anchorX, GUTTER_W) - GUTTER_W) / nextPps;
    onZoomChange(next);
  }, [geometry, onZoomChange]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      applyZoomAnchored(e.deltaY < 0 ? 1.25 : 0.8, canvasPos(e).x);
      return;
    }
    const { pps } = geometry();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    scrollSecRef.current += delta / pps;
    followRef.current = false; // explicit pan — stop chasing the playhead
    scheduleDraw();
  }, [applyZoomAnchored, geometry, scheduleDraw]);

  // React attaches wheel listeners passively — preventDefault needs a native
  // non-passive listener or the page scrolls/zooms along with the roll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handlePointerDown = (e) => {
    canvasRef.current.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { ...canvasPos(e), moved: false });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { startDist: Math.abs(a.x - b.x) || 1, startZoom: zoomRef.current };
      // A pinch is never a tap — mark both pointers moved so the anchored
      // finger's release doesn't scrub the playhead as a side effect of zooming.
      pointersRef.current.forEach((p, id) => pointersRef.current.set(id, { ...p, moved: true }));
    }
  };

  const handlePointerMove = (e) => {
    const pos = canvasPos(e);
    const tracked = pointersRef.current.get(e.pointerId);
    if (tracked) {
      // Pinch zoom (two pointers) or drag pan (one pointer).
      if (pointersRef.current.size === 2 && pinchRef.current) {
        pointersRef.current.set(e.pointerId, { ...pos, moved: true });
        const [a, b] = [...pointersRef.current.values()];
        const dist = Math.abs(a.x - b.x) || 1;
        const next = clampZoom(pinchRef.current.startZoom * (dist / pinchRef.current.startDist));
        if (next !== zoomRef.current) onZoomChange(next);
        return;
      }
      const { pps } = geometry();
      const dx = pos.x - tracked.x;
      if (Math.abs(dx) > 2 || tracked.moved) {
        scrollSecRef.current -= dx / pps;
        followRef.current = false; // explicit pan — stop chasing the playhead
        pointersRef.current.set(e.pointerId, { ...pos, moved: true });
        setHoverIdentity(null);
        scheduleDraw();
        return;
      }
    }
    // Plain hover (mouse) — tooltip hit-test. Position always tracks the
    // cursor; identity state only changes when a different note/chord is hit.
    moveTooltip(pos.x, pos.y);
    setHoverIdentity(hitTest(pos.x, pos.y));
  };

  const handlePointerUp = (e) => {
    const tracked = pointersRef.current.get(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (!tracked || tracked.moved) return;
    // A tap/click: on a note → tooltip (touch fallback); else → scrub playhead.
    const pos = canvasPos(e);
    const hit = hitTest(pos.x, pos.y);
    if (hit) {
      moveTooltip(pos.x, pos.y);
      setHoverIdentity(hit);
      return;
    }
    const { pps, gridTop } = geometry();
    if (pos.x >= GUTTER_W && pos.y >= gridTop) {
      playheadSecRef.current = scrollSecRef.current + (pos.x - GUTTER_W) / pps;
      followRef.current = true; // a seek re-follows
      onSeek?.(playheadSecRef.current);
      setHoverIdentity(null);
      draw();
    }
  };

  const handleKeyDown = (e) => {
    const { pps, gridW } = geometry();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) {
        scrollSecRef.current += dir * (gridW / pps) * 0.5;
        followRef.current = false; // explicit pan — stop chasing the playhead
      } else {
        playheadSecRef.current = Math.min(duration, Math.max(0, playheadSecRef.current + dir * (10 / pps)));
        followRef.current = true; // a seek re-follows
        onSeek?.(playheadSecRef.current);
      }
      draw();
    } else if (e.key === ' ' && onTogglePlay) {
      e.preventDefault(); // keep Space from scrolling the page
      onTogglePlay();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      onZoomChange(clampZoom(zoomRef.current * ZOOM_STEP));
    } else if (e.key === '-') {
      e.preventDefault();
      onZoomChange(clampZoom(zoomRef.current / ZOOM_STEP));
    } else if (e.key === '0') {
      e.preventDefault();
      scrollSecRef.current = 0;
      onZoomChange(MIN_ZOOM);
      draw(); // zoom may already be at MIN_ZOOM — the scroll reset still needs a repaint
    } else if (e.key === 'Escape') {
      setHoverIdentity(null);
    }
  };

  const tooltip = hover && (hover.kind === 'note'
    ? `${hover.note.name} · ${formatTimecode(hover.note.startSec)} · ${Math.round(hover.note.durationSec * 1000)}ms · v=${Math.round((hover.note.velocity ?? 0) * 127)}${multiTrack ? ` · track ${hover.note.track}` : ''}`
    : `${hover.chord.label} · ${chordNoteNames(hover.chord.midis)}`);

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        className="block w-full rounded-lg bg-[#0c0c0e] touch-none cursor-crosshair focus:outline-none focus:ring-1 focus:ring-port-accent"
        tabIndex={0}
        role="img"
        aria-label={`MIDI piano roll: ${data?.notes?.length || 0} notes, ${midiNoteName(data?.minMidi ?? 60)} to ${midiNoteName(data?.maxMidi ?? 71)}, ${formatTimecode(duration)} long. Use plus and minus to zoom, arrow keys to move the playhead, shift plus arrows to pan${onTogglePlay ? ', space to play or pause' : ''}.`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={(e) => {
          pointersRef.current.clear();
          pinchRef.current = null;
          // Touch pointerup is immediately followed by pointerleave — clearing
          // hover here would erase the tap-tooltip before it ever paints. A tap
          // on empty grid or Escape clears a touch tooltip instead.
          if (e.pointerType !== 'touch') setHoverIdentity(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {tooltip && (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-10 px-1.5 py-0.5 rounded bg-black/90 border border-port-border text-[10px] text-gray-200 whitespace-nowrap"
          style={tooltipStyle(tooltipPosRef.current.x, tooltipPosRef.current.y, widthRef.current || 0)}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}
