import { useEffect, useRef, useState } from 'react';
import { CREDITS_OUTRO_FACE_LOADS, CREDITS_OUTRO_FONTS, drawCreditsOutro } from '../../../../server/lib/musicVideo/musicVideoCreditsOutro.js';

// The canvas the animatic paints at; CSS scales it to the figure. The final render paints at the cut's own size.
const WIDTH = 1280;
const HEIGHT = 720;

let facesAdded = false;
// The credits' faces (the same bundled files the render page declares), registered once per page.
function addCreditsFaces() {
  if (facesAdded || typeof FontFace !== 'function' || !document.fonts?.add) return;
  facesAdded = true;
  for (const { family, file, weight } of Object.values(CREDITS_OUTRO_FONTS)) {
    document.fonts.add(new FontFace(family, `url(/fonts/title-card/${file})`, { weight }));
  }
}

/**
 * The film credits ending (lib/musicVideo/musicVideoCreditsOutro.js) at scene time `t`,
 * painted by the same function the final render captures. `credits` is the
 * normalized record.
 */
export default function CreditsOutroCanvas({ credits, t, durationSec }) {
  const canvasRef = useRef(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [bgImage, setBgImage] = useState(null);
  const bgId = credits?.backgroundImageId || '';

  useEffect(() => {
    addCreditsFaces();
    let active = true;
    Promise.allSettled(CREDITS_OUTRO_FACE_LOADS.map((font) => document.fonts?.load?.(font)))
      .then(() => { if (active) setFontsReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!bgId) { setBgImage(null); return undefined; }
    let active = true;
    const img = new Image();
    img.onload = () => { if (active) setBgImage(img); };
    img.onerror = () => { if (active) setBgImage(null); };
    img.src = `/data/images/${encodeURIComponent(bgId)}`;
    return () => { active = false; };
  }, [bgId]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext?.('2d');
    if (!ctx) return;
    drawCreditsOutro(ctx, { width: WIDTH, height: HEIGHT, t, durationSec, credits, bgImage });
  }, [t, durationSec, credits, fontsReady, bgImage]);
  const label = [credits?.title, credits?.showPerformer === false ? '' : credits?.artist].filter(Boolean).join(', performed by ');

  return (
    <canvas
      ref={canvasRef}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={`Credits${label ? `: ${label}` : ''}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-testid="animatic-credits-outro"
    />
  );
}
