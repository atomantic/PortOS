import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { midiNoteName, isBlackKey } from '../../lib/pianoKeyboard';
import { chordNoteNames } from '../../lib/midiChords';
import { roundRect, layerColor } from '../../lib/canvasRoll.js';
import { formatTimecode, formatDurationSec } from '../../utils/formatters';
import useCanvasDprSize from '../../hooks/useCanvasDprSize.js';
import useCanvasRollPalette from '../../hooks/useCanvasRollPalette.js';

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
const GUTTER_BG = '#131316';
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
// scanning from note 0 in the 60fps playback loop's sounding-set sweep.
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

// Shallow-compare two offscreen-scene signatures. `data`/`chords` compare by
// reference (a new parse is a new object); everything else by value. Any
// mismatch means the cached bitmap is stale and the scene must be repainted.
const sceneSigEqual = (a, b) => !!a && !!b
  && a.width === b.width && a.height === b.height && a.zoom === b.zoom
  && a.scroll === b.scroll && a.chordLaneH === b.chordLaneH
  && a.lowMidi === b.lowMidi && a.highMidi === b.highMidi
  && a.multiTrack === b.multiTrack
  && a.backingW === b.backingW && a.backingH === b.backingH
  && a.data === b.data && a.chords === b.chords
  && a.bg === b.bg && a.accent === b.accent && a.accentRgb === b.accentRgb;

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
  // Cached offscreen "scene" (grid + notes + gutter, no playhead/hover) keyed
  // on everything that changes it — reused across hover/playhead repaints so a
  // mouse move over a 10k-note file drawImage()s the bitmap instead of redrawing
  // every note bar. Rebuilt only when the sig actually changes (pan/zoom/resize/
  // data/theme).
  const sceneRef = useRef({ canvas: null, sig: null });
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
  // playback loop, painted onto the pitch gutter by the overlay pass.
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

  // Notes bucketed by pitch (sorted-by-startSec preserved from parseMidiFile),
  // so hit-testing scans one row instead of every note (~88× fewer) and chord
  // hover strokes look up members by midi.
  const notesByMidi = useMemo(() => {
    const map = new Map();
    (data?.notes || []).forEach((n) => {
      const arr = map.get(n.midi);
      if (arr) arr.push(n); else map.set(n.midi, [n]);
    });
    return map;
  }, [data]);

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
    const geo = geometry();
    const { width, gridW, pps, gridTop, gridH, rowH, maxScroll } = geo;
    if (!canvas || !width) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    scrollSecRef.current = Math.min(Math.max(0, scrollSecRef.current), maxScroll);
    const scroll = scrollSecRef.current;
    const viewEnd = scroll + gridW / pps;
    const { bg, accent, accentRgb } = paletteRef.current;
    const timeToX = (sec) => GUTTER_W + (sec - scroll) * pps;
    const midiToY = (m) => gridTop + (highMidi - m) * rowH;

    // The full grid + notes + gutter is invariant under hover and playhead
    // moves, so paint it to an offscreen bitmap keyed on the values that DO
    // change it and reuse that bitmap for every other repaint. On a dense file
    // this turns a hover/scrub repaint from "redraw every note bar" into a
    // single drawImage() + a couple of overlay strokes.
    const paintScene = (octx) => {
      octx.clearRect(0, 0, width, height);
      octx.fillStyle = bg;
      octx.fillRect(0, 0, width, height);

      // Horizontal pitch rows — black-key rows tinted, every C stronger.
      for (let m = lowMidi; m <= highMidi; m += 1) {
        const y = midiToY(m);
        if (m % 12 === 0) {
          octx.fillStyle = C_LINE;
          octx.fillRect(GUTTER_W, y + rowH, gridW, 1);
        } else if (rowH >= 4) {
          if (isBlackKey(m)) {
            octx.fillStyle = 'rgba(255,255,255,0.02)';
            octx.fillRect(GUTTER_W, y, gridW, rowH);
          }
          octx.fillStyle = GRID_LINE;
          octx.fillRect(GUTTER_W, y + rowH, gridW, 1);
        }
      }

      // Vertical time grid + ruler labels.
      const step = tickStep(pps);
      octx.font = '9px ui-sans-serif, system-ui, sans-serif';
      octx.textAlign = 'left';
      for (let t = Math.floor(scroll / step) * step; t <= viewEnd; t += step) {
        if (t < 0) continue;
        const x = timeToX(t);
        if (x < GUTTER_W) continue;
        octx.fillStyle = GRID_LINE;
        octx.fillRect(x, gridTop, 1, gridH);
        octx.fillStyle = TEXT_DIM;
        // Sub-second tick steps keep the fractional timecode (adjacent labels
        // would otherwise read "0:03 0:03 0:03"); whole-second steps use the
        // plain M:SS formatter.
        octx.fillText(step < 1 ? formatTimecode(t) : formatDurationSec(t), x + 3, RULER_H - 6);
      }

      // Chord lane (dim — the hovered chord is brightened in the overlay pass).
      if (chordLaneH) {
        octx.fillStyle = 'rgba(255,255,255,0.03)';
        octx.fillRect(GUTTER_W, RULER_H, gridW, chordLaneH);
        (chords || []).forEach((c) => {
          if (c.endSec < scroll || c.startSec > viewEnd) return;
          const x0 = Math.max(GUTTER_W, timeToX(c.startSec));
          const x1 = Math.min(width, timeToX(c.endSec));
          if (x1 - x0 < 2) return;
          octx.fillStyle = `rgb(${accentRgb} / 0.10)`;
          octx.fillRect(x0, RULER_H + 1, x1 - x0 - 1, chordLaneH - 2);
          // Sticky-left label, clipped to the window.
          octx.save();
          octx.beginPath();
          octx.rect(x0, RULER_H, x1 - x0, chordLaneH);
          octx.clip();
          octx.fillStyle = '#9ca3af';
          octx.font = '10px ui-sans-serif, system-ui, sans-serif';
          octx.fillText(c.label, x0 + 3, RULER_H + chordLaneH - 6);
          octx.restore();
        });
      }

      // Notes — only those intersecting the visible window, clipped to the grid.
      // The list is sorted by startSec (parseMidiFile), so start at the first
      // note that can still overlap the left edge and bail at the right edge.
      octx.save();
      octx.beginPath();
      octx.rect(GUTTER_W, gridTop, gridW, gridH);
      octx.clip();
      octx.textAlign = 'left';
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
        roundRect(octx, x, y + 0.5, w, h, NOTE_RADIUS);
        octx.fillStyle = multiTrack ? layerColor(n.track) : accent;
        octx.globalAlpha = 0.35 + 0.6 * (n.velocity ?? 0.8);
        octx.fill();
        octx.globalAlpha = 1;
        // In-bar note name when it fits.
        if (w >= 28 && rowH >= 12) {
          octx.fillStyle = bg;
          octx.font = '9px ui-sans-serif, system-ui, sans-serif';
          octx.fillText(n.name || midiNoteName(n.midi), x + 3, y + h - Math.max(1, (h - 8) / 2));
        }
      }
      octx.restore();

      // Pitch gutter on top (opaque, so notes pan "under" it).
      octx.fillStyle = GUTTER_BG;
      octx.fillRect(0, gridTop, GUTTER_W, gridH);
      octx.textAlign = 'right';
      for (let m = lowMidi; m <= highMidi; m += 1) {
        const y = midiToY(m);
        if (m % 12 === 0 && rowH >= 3) {
          octx.fillStyle = TEXT_DIM;
          octx.font = '9px ui-sans-serif, system-ui, sans-serif';
          octx.fillText(midiNoteName(m), GUTTER_W - 4, y + rowH - 1);
          octx.fillStyle = C_LINE;
          octx.fillRect(0, y + rowH, GUTTER_W, 1);
        } else if (rowH >= 7) {
          octx.fillStyle = isBlackKey(m) ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.10)';
          octx.fillRect(GUTTER_W - 8, y + 1, 5, Math.max(1, rowH - 2));
        }
      }
      // Scroll indicator along the bottom when zoomed in.
      if (maxScroll > 0) {
        const frac = gridW / (duration * pps);
        const barW = Math.max(24, gridW * frac);
        const barX = GUTTER_W + (scroll / maxScroll) * (gridW - barW);
        octx.fillStyle = 'rgba(255,255,255,0.15)';
        octx.fillRect(barX, height - 3, barW, 2);
      }
    };

    // Live overlay: the hovered chord's bright box + label, hovered-note white
    // strokes, the playhead, and the sounding-pitch gutter lights — everything
    // that moves without invalidating the cached scene.
    const paintOverlay = (octx) => {
      if (hover?.kind === 'chord' && chordLaneH) {
        const c = hover.chord;
        if (!(c.endSec < scroll || c.startSec > viewEnd)) {
          const x0 = Math.max(GUTTER_W, timeToX(c.startSec));
          const x1 = Math.min(width, timeToX(c.endSec));
          if (x1 - x0 >= 2) {
            // Repaint the strip under the box so the brighter fill doesn't
            // composite on top of the baked dim box.
            octx.fillStyle = bg;
            octx.fillRect(x0, RULER_H, x1 - x0, chordLaneH);
            octx.fillStyle = 'rgba(255,255,255,0.03)';
            octx.fillRect(x0, RULER_H, x1 - x0, chordLaneH);
            octx.fillStyle = `rgb(${accentRgb} / 0.25)`;
            octx.fillRect(x0, RULER_H + 1, x1 - x0 - 1, chordLaneH - 2);
            octx.save();
            octx.beginPath();
            octx.rect(x0, RULER_H, x1 - x0, chordLaneH);
            octx.clip();
            octx.fillStyle = '#dbeafe';
            octx.font = '10px ui-sans-serif, system-ui, sans-serif';
            octx.fillText(c.label, x0 + 3, RULER_H + chordLaneH - 6);
            octx.restore();
          }
        }
      }

      // White outline on the hovered note (or every note in the hovered chord),
      // clipped to the grid so a stroke can't bleed over the gutter/ruler.
      if (hover) {
        octx.save();
        octx.beginPath();
        octx.rect(GUTTER_W, gridTop, gridW, gridH);
        octx.clip();
        octx.strokeStyle = '#ffffff';
        octx.lineWidth = 1;
        const strokeNote = (n) => {
          if (n.midi < lowMidi || n.midi > highMidi) return;
          const w = Math.max(2, n.durationSec * pps);
          const h = Math.max(2, rowH - 1);
          roundRect(octx, timeToX(n.startSec), midiToY(n.midi) + 0.5, w, h, NOTE_RADIUS);
          octx.stroke();
        };
        if (hover.kind === 'note') {
          strokeNote(hover.note);
        } else if (hover.kind === 'chord') {
          const span = hover.chord;
          span.midis.forEach((m) => {
            (notesByMidi.get(m) || []).forEach((n) => {
              const end = n.startSec + n.durationSec;
              if (n.startSec < span.endSec && end > span.startSec) strokeNote(n);
            });
          });
        }
        octx.restore();
      }

      // Playhead — scrub position when idle, live audio position while playing
      // (the rAF loop mutates playheadSecRef from getPosition() each frame).
      const px = timeToX(playheadSecRef.current);
      if (px >= GUTTER_W && px <= width) {
        octx.fillStyle = accent;
        octx.fillRect(px - 1, RULER_H, 2, height - RULER_H);
      }

      // Sounding pitches (synth preview, playing only) — the gutter is baked
      // opaque into the scene, so tint the row on top and re-draw its C label
      // so the octave anchor stays readable under the highlight.
      const soundingMidis = soundingRef.current;
      if (soundingMidis?.size) {
        for (const m of soundingMidis) {
          if (m < lowMidi || m > highMidi) continue;
          const y = midiToY(m);
          octx.fillStyle = `rgb(${accentRgb} / 0.35)`;
          octx.fillRect(0, y, GUTTER_W, Math.max(1, rowH));
          if (m % 12 === 0 && rowH >= 3) {
            octx.textAlign = 'right';
            octx.fillStyle = '#e5e7eb';
            octx.font = '9px ui-sans-serif, system-ui, sans-serif';
            octx.fillText(midiNoteName(m), GUTTER_W - 4, y + rowH - 1);
          }
        }
      }
    };

    // Rebuild the offscreen scene only when its signature changed; otherwise
    // reuse the cached bitmap. DPR is derived from the visible canvas's actual
    // backing store (set by useCanvasDprSize) rather than reading
    // window.devicePixelRatio directly — so the offscreen always matches the
    // visible canvas's resolution even if the DPR changes before the sizing hook
    // re-runs (a fresh-DPR scene composited into a stale-DPR canvas would blur).
    const fallbackDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const backingW = canvas.width || Math.round(width * fallbackDpr);
    const backingH = canvas.height || Math.round(height * fallbackDpr);
    const dpr = backingW / width;
    const sig = {
      width, height, zoom: zoomRef.current, scroll, chordLaneH,
      lowMidi, highMidi, multiTrack, backingW, backingH,
      data, chords: chordLaneH ? chords : null, bg, accent, accentRgb,
    };
    const cached = sceneRef.current;
    if (!cached.canvas || !sceneSigEqual(cached.sig, sig)) {
      const off = cached.canvas
        || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      if (off) {
        // Only re-allocate (which clears + resets the transform) when the pixel
        // size actually changes; a pan/theme rebuild keeps the same buffer and
        // repaints over it (paintScene clears its own frame first).
        if (off.width !== backingW || off.height !== backingH) { off.width = backingW; off.height = backingH; }
        const octx = off.getContext('2d');
        if (octx) {
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          paintScene(octx);
        }
        sceneRef.current = { canvas: off, sig };
      }
    }

    ctx.clearRect(0, 0, width, height);
    const scene = sceneRef.current.canvas;
    if (scene) ctx.drawImage(scene, 0, 0, width, height);
    else paintScene(ctx); // no offscreen available (SSR) — paint direct
    paintOverlay(ctx);
  }, [data, chords, chordLaneH, geometry, height, highMidi, lowMidi, hover, multiTrack, duration, notesByMidi, maxDurSec]);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Theme-following canvas palette (accent + bg) read inside draw() via the
  // ref; re-resolves and repaints on theme switch.
  const paletteRef = useCanvasRollPalette(drawRef);

  // DPR-aware canvas sizing + redraw on container resize (shared hook).
  const widthRef = useCanvasDprSize(wrapRef, canvasRef, height, drawRef);

  useEffect(() => { draw(); }, [draw, zoom]);

  // Drop the hovered note/chord identity when the underlying file swaps
  // (re-transcription updating `data`, or the Retry path replacing `chords`).
  // The identity holds objects from the PREVIOUS parse; without this, a
  // stationary hover over the canvas would keep `paintOverlay` stroking the
  // stale note/chord at coordinates mapped into the NEW file until the next
  // pointer move or Escape.
  useEffect(() => { setHover(null); }, [data, chords]);

  // Playback rAF loop: while playing, read the live audio position into the
  // playhead ref, page the view to keep it visible, compute the sounding
  // pitch set for the gutter, and repaint — but only when a frame is visually
  // different (playhead pixel, sounding set, or a page turn). At fit zoom the
  // playhead moves well under a pixel per frame, so most frames skip the
  // repaint entirely. On pause/stop the loop tears down and one static frame
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
    // Only the notes on this pitch row (index by midi) instead of every note;
    // iterate back-to-front so the top-drawn (later) note wins the hit. The
    // 2/pps term keeps min-width (2px) bars hittable.
    const row = notesByMidi.get(midi);
    if (!row) return null;
    for (let i = row.length - 1; i >= 0; i -= 1) {
      const n = row[i];
      if (sec >= n.startSec && sec <= n.startSec + Math.max(n.durationSec, 2 / pps)) {
        return { kind: 'note', note: n };
      }
    }
    return null;
  }, [chords, chordLaneH, geometry, highMidi, notesByMidi]);

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
