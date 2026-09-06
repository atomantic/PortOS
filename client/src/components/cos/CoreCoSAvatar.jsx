import { useEffect, useRef } from 'react';
import CoSAvatarFrame from './CoSAvatarFrame';
import { AGENT_STATES } from './constants';
import { drawWireframeCore } from '../../lib/wireframeCore.js';
import { parseColor, parseTriple } from '../../lib/chipContrast.js';
import useCanvasDprSize from '../../hooks/useCanvasDprSize.js';
import useCanvasRollPalette from '../../hooks/useCanvasRollPalette.js';
import usePrefersReducedMotion from '../../hooks/usePrefersReducedMotion.js';

// Core Assembly — the Kestrel Neon concept's rotating wireframe icosahedron,
// drawn on a plain 2D canvas. No WebGL, so it skips CoSCanvasGuard and works
// on displays where the three.js avatars fall back to the failure panel.
//
// Colors: edges take the agent-state color (the intentional 7-way enum in
// `AGENT_STATES`, so every state stays distinguishable), while the rings and
// vertices follow the active theme's secondary accent — magenta under Kestrel
// Neon, whatever `--port-accent-2` is elsewhere.

// Per-state motion: radians/second of spin and how hard the glow breathes.
const STATE_MOTION = {
  sleeping: { spin: 0.25, breathe: 0.15 },
  thinking: { spin: 0.7, breathe: 0.5 },
  coding: { spin: 1.1, breathe: 0.8 },
  investigating: { spin: 0.9, breathe: 0.7 },
  reviewing: { spin: 0.6, breathe: 0.45 },
  planning: { spin: 0.5, breathe: 0.35 },
  ideating: { spin: 1.3, breathe: 1 },
};

// Edge color per state, parsed once — the draw loop must not re-parse hex
// every frame for one of seven values.
const FALLBACK_EDGE_RGB = [0, 240, 255];
const STATE_EDGE_RGB = Object.fromEntries(Object.entries(AGENT_STATES).map(([state, { color }]) => {
  const parsed = parseColor(color);
  return [state, parsed ? [parsed.r, parsed.g, parsed.b] : FALLBACK_EDGE_RGB];
}));

const FALLBACK_NODE_RGB = [255, 43, 214];
const FALLBACK_DIM_RGB = [107, 115, 144];
const TILT = 0.5;

const readTriple = (styles, prop, fallback) => {
  const { r, g, b } = parseTriple(styles.getPropertyValue(prop));
  return [r, g, b].every(Number.isFinite) ? [r, g, b] : fallback;
};

// Canvas fillStyle can't read CSS custom properties; useCanvasRollPalette
// re-runs this on every theme switch.
const resolvePalette = () => {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return { nodeRgb: FALLBACK_NODE_RGB, dimRgb: FALLBACK_DIM_RGB, font: 'monospace' };
  }
  const styles = getComputedStyle(document.documentElement);
  return {
    nodeRgb: readTriple(styles, '--port-accent-2', FALLBACK_NODE_RGB),
    dimRgb: readTriple(styles, '--port-text-subtle', FALLBACK_DIM_RGB),
    font: styles.getPropertyValue('--port-font-mono').trim() || 'monospace',
  };
};

export default function CoreCoSAvatar({ state = 'sleeping', speaking = false, background = false }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const drawRef = useRef(null);
  // Latest props for the animation loop — the loop is bound once so a state
  // change never restarts the spin from zero.
  const propsRef = useRef({ state, speaking });
  propsRef.current = { state, speaking };
  const reduceMotion = usePrefersReducedMotion();
  const paletteRef = useCanvasRollPalette(drawRef, resolvePalette);
  useCanvasDprSize(wrapRef, canvasRef, undefined, drawRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return undefined;

    let spin = 0.8;
    let phase = 0;
    let lastTs = null;
    let raf = 0;
    // Drag offsets so "Drag to rotate" on the frame is true for this avatar too.
    const drag = { pointerId: null, x: 0, y: 0, ax: 0, ay: 0 };

    const draw = (ts = performance.now()) => {
      const { state: currentState, speaking: isSpeaking } = propsRef.current;
      const motion = STATE_MOTION[currentState] || STATE_MOTION.sleeping;
      const dt = lastTs === null || reduceMotion ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      spin += dt * motion.spin * (isSpeaking ? 1.8 : 1);
      phase += dt * (0.4 + (isSpeaking ? 1.2 : 0));
      const breathe = reduceMotion ? 0 : motion.breathe * (0.5 + 0.5 * Math.sin(ts / 700));
      // useCanvasDprSize sized the bitmap at the device pixel ratio; draw in CSS px.
      const dpr = window.devicePixelRatio || 1;
      drawWireframeCore(ctx, {
        width: canvas.width / dpr,
        height: canvas.height / dpr,
        ax: TILT + drag.ax,
        ay: spin + drag.ay,
        phase,
        pulse: Math.min(1, breathe + (isSpeaking ? 0.5 : 0)),
        edgeRgb: STATE_EDGE_RGB[currentState] || STATE_EDGE_RGB.sleeping,
        ...paletteRef.current,
      });
    };
    drawRef.current = () => draw();

    const loop = (ts) => {
      draw(ts);
      // Under reduced motion one frame is the whole animation.
      if (!reduceMotion) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onPointerDown = (event) => {
      drag.pointerId = event.pointerId;
      drag.x = event.clientX;
      drag.y = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event) => {
      if (drag.pointerId !== event.pointerId) return;
      drag.ay += (event.clientX - drag.x) * 0.01;
      drag.ax += (event.clientY - drag.y) * 0.01;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (reduceMotion) draw();
    };
    const onPointerUp = (event) => {
      if (drag.pointerId === event.pointerId) drag.pointerId = null;
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      drawRef.current = null;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [paletteRef, reduceMotion]);

  // Under reduced motion the loop is halted, so a state change (new edge color)
  // has to ask for its one frame explicitly.
  useEffect(() => {
    if (reduceMotion) drawRef.current?.();
  }, [state, speaking, reduceMotion]);

  return (
    <CoSAvatarFrame label="Core assembly avatar. Drag to rotate." background={background}>
      <div ref={wrapRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          data-testid="core-avatar-canvas"
          data-state={state}
          className="block w-full h-full"
        />
      </div>
    </CoSAvatarFrame>
  );
}
