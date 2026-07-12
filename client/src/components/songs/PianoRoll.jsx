import { useCallback, useEffect, useMemo, useRef } from 'react';
import { parseScore } from '../../lib/scoreNotation';
import { buildSchedule } from '../../lib/scorePlayback';
import {
  buildKeyboardLayout,
  keyboardRange,
  midiNoteName,
  BLACK_KEY_HEIGHT_RATIO,
} from '../../lib/pianoKeyboard';
import { roundRect } from '../../lib/canvasRoll.js';
import useCanvasDprSize from '../../hooks/useCanvasDprSize.js';

// Synthesia-style piano-roll visualizer for the song system's layered MIDI
// player. Renders every selected lead-sheet part as colored notes falling onto
// a piano keyboard, lighting up the keys as each note crosses the hit line —
// the aggregate of all layers played "on the piano" at once.
//
// Layout, key geometry and the per-note `midi` come from pure helpers
// (pianoKeyboard.js / scorePlayback.js); this component only draws to a <canvas>
// and runs the rAF clock. The live playhead comes from `getPosition()` (the
// multi-score player's position() in score-seconds) so the fall stays
// sample-aligned with the audio rather than running its own timer.

// Per-layer colors, assigned by part index in the parent so the keyboard, the
// falling notes and the layer checkboxes all agree. Re-exported from the
// shared canvas-roll palette so <MidiPianoRoll> and legends use the same hues.
export { layerColor } from '../../lib/canvasRoll.js';

const VISIBLE_SECONDS = 3.4; // how far ahead the falling notes are shown (fall speed)
const KEYBOARD_HEIGHT = 64;  // px of keyboard at the bottom
const NOTE_RADIUS = 3;
const WHITE_KEY_FILL = '#e7e7ea';
const WHITE_KEY_EDGE = '#9a9aa2';
const BLACK_KEY_FILL = '#1b1b20';
const BLACK_KEY_EDGE = '#000000';
const HIT_LINE = '#3b82f6';
const GRID_LINE = 'rgba(255,255,255,0.05)';
const BG = '#0c0c0e';

/**
 * @param {object} props
 * @param {Array<{id:string,label:string,color:string,score:string}>} props.parts
 *   — the selected layers (raw lead-sheet text); parsed + scheduled here.
 * @param {number} props.tempo — BPM applied to every part (mirrors the player).
 * @param {()=>number} props.getPosition — live playhead in score-seconds (stable
 *   reference; reads the player's position()).
 * @param {boolean} props.playing — drives the rAF loop; a static frame is drawn
 *   when paused.
 * @param {number} [props.height=300]
 */
export default function PianoRoll({ parts, tempo, getPosition, playing, height = 300 }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  // Keep the latest getPosition without making it a draw() dependency (the parent
  // hands a fresh closure each render; the rAF loop should not restart for that).
  const getPositionRef = useRef(getPosition);
  getPositionRef.current = getPosition;
  // Read inside draw() (a ref, not a dep) so a key only lights while audio is
  // actually sounding — paused/idle freezes the bars but presses no keys.
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // Parse + schedule every part once per parts/tempo change → flat note list.
  const { notes, range } = useMemo(() => {
    const all = [];
    (parts || []).forEach((p) => {
      const { events } = buildSchedule(parseScore(p.score), tempo);
      events.forEach((ev) => {
        if (ev.rest || !Number.isFinite(ev.midi)) return;
        all.push({ midi: ev.midi, startSec: ev.startSec, durSec: ev.durSec, color: p.color });
      });
    });
    return { notes: all, range: keyboardRange(all.map((n) => n.midi)) };
  }, [parts, tempo]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const width = widthRef.current;
    if (!canvas || !width) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Keep the negative LEAD-in pre-roll intact (only guard non-finite) so a
    // falling note reaches the hit line exactly when its audio starts.
    const rawPos = getPositionRef.current?.() ?? 0;
    const pos = Number.isFinite(rawPos) ? rawPos : 0;
    const isPlaying = playingRef.current;
    // Clamp the keyboard band so a small `height` degrades gracefully instead of
    // a negative hitLineY (which would invert the fall direction).
    const kbH = Math.min(KEYBOARD_HEIGHT, height);
    const hitLineY = height - kbH;
    const pps = hitLineY / VISIBLE_SECONDS; // pixels per second of fall
    const layout = buildKeyboardLayout({ lowMidi: range.lowMidi, highMidi: range.highMidi, width });
    const keyByMidi = new Map(layout.keys.map((k) => [k.midi, k]));

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, hitLineY);

    // Faint vertical octave gridlines (on every C) to anchor the eye.
    ctx.fillStyle = GRID_LINE;
    layout.keys.forEach((k) => {
      if (!k.isBlack && k.midi % 12 === 0) ctx.fillRect(k.x, 0, 1, hitLineY);
    });

    // Falling notes, clipped to the area above the keyboard so they vanish into
    // the keys as they're played.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, hitLineY);
    ctx.clip();
    const active = new Map(); // midi → color of a currently-sounding note
    notes.forEach((n) => {
      const key = keyByMidi.get(n.midi);
      if (!key) return;
      const h = Math.max(2, n.durSec * pps);
      const bottom = hitLineY - (n.startSec - pos) * pps;
      const top = bottom - h;
      if (isPlaying && n.startSec <= pos && pos < n.startSec + n.durSec) active.set(n.midi, n.color);
      if (top >= hitLineY || bottom <= 0) return; // outside the visible fall window
      const pad = key.isBlack ? 1 : 1.5;
      roundRect(ctx, key.x + pad, top, Math.max(2, key.w - pad * 2), h, NOTE_RADIUS);
      ctx.fillStyle = n.color;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    // Hit line.
    ctx.fillStyle = HIT_LINE;
    ctx.fillRect(0, hitLineY - 1, width, 2);

    // Keyboard — white keys first, then black overlaid. Active keys glow in the
    // sounding note's layer color.
    const blackH = kbH * BLACK_KEY_HEIGHT_RATIO;
    layout.keys.filter((k) => !k.isBlack).forEach((k) => {
      const lit = active.get(k.midi);
      ctx.fillStyle = lit || WHITE_KEY_FILL;
      ctx.fillRect(k.x, hitLineY, k.w, kbH);
      ctx.strokeStyle = WHITE_KEY_EDGE;
      ctx.lineWidth = 1;
      ctx.strokeRect(k.x + 0.5, hitLineY + 0.5, k.w - 1, kbH - 1);
      // Octave label on each C.
      if (k.midi % 12 === 0 && k.w > 14) {
        ctx.fillStyle = lit ? '#0c0c0e' : '#71717a';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(midiNoteName(k.midi), k.x + k.w / 2, hitLineY + kbH - 5);
      }
    });
    layout.keys.filter((k) => k.isBlack).forEach((k) => {
      const lit = active.get(k.midi);
      ctx.fillStyle = lit || BLACK_KEY_FILL;
      roundRect(ctx, k.x, hitLineY, k.w, blackH, 2);
      ctx.fill();
      ctx.strokeStyle = BLACK_KEY_EDGE;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }, [notes, range, height]);

  // Latest draw without making it an observer dependency — keeps the
  // ResizeObserver created once per height (not torn down on every notes/tempo
  // change, which only needs a redraw, not a re-observe).
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Size the canvas to the container (devicePixelRatio-aware) and redraw.
  const widthRef = useCanvasDprSize(wrapRef, canvasRef, height, drawRef);

  // rAF clock: animate the fall while playing, otherwise draw a single frame.
  useEffect(() => {
    draw();
    if (!playing) return undefined;
    let raf = 0;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw]);

  return (
    <div ref={wrapRef} className="w-full">
      <canvas ref={canvasRef} className="block w-full rounded-lg bg-[#0c0c0e]" aria-hidden="true" />
      <p className="sr-only">
        Piano-roll visualization of the selected song layers falling onto a piano keyboard.
      </p>
    </div>
  );
}
