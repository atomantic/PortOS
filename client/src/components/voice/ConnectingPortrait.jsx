import { useEffect, useRef } from 'react';

// Resolutions the portrait steps through, coarse to fine, like a picture arriving over a slow link; then it starts over.
export const CONNECTING_STEPS = [6, 10, 16, 24, 36, 52];
const STEP_MS = 420;
const REDUCED_MOTION_STEP = 16;

/**
 * The still portrait re-drawn at low resolution and scaled up with hard pixels, sharpening step by step, while the call
 * is connecting (AvatarForcing warming up or the realtime voice loading). Under reduced motion it holds one coarse
 * frame. Purely decorative: the status chip says what is happening.
 */
export default function ConnectingPortrait({ src }) {
  const canvas = useRef(null);
  useEffect(() => {
    const target = canvas.current;
    const ctx = target?.getContext?.('2d');
    if (!ctx || !src) return undefined;
    const image = new Image();
    let step = 0;
    let timer;
    let disposed = false;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const draw = (res) => {
      target.width = res;
      target.height = res;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(image, 0, 0, res, res);
    };
    image.onload = () => {
      if (disposed) return;
      if (reduced) { draw(REDUCED_MOTION_STEP); return; }
      const tick = () => {
        draw(CONNECTING_STEPS[step % CONNECTING_STEPS.length]);
        step += 1;
        timer = setTimeout(tick, STEP_MS);
      };
      tick();
    };
    image.src = src;
    return () => { disposed = true; clearTimeout(timer); image.onload = null; };
  }, [src]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <canvas ref={canvas} data-testid="connecting-portrait" className="block size-full" style={{ imageRendering: 'pixelated' }} />
      <div className="satphone-connecting-sweep absolute inset-x-0 h-1/5 motion-reduce:hidden" />
    </div>
  );
}
