import { useEffect, useRef, useState } from 'react';
import { STATS_OUTRO_FONTS, drawStatsOutro } from '../../../../server/lib/musicVideoStatsOutro.js';

// The canvas the animatic paints at; CSS scales it to the figure. The final render paints at the cut's own size.
const WIDTH = 1280;
const HEIGHT = 720;

let facesAdded = false;
// The outro's faces (the same bundled files the render page declares), registered once per page.
function addOutroFaces() {
  if (facesAdded || typeof FontFace !== 'function' || !document.fonts?.add) return;
  facesAdded = true;
  for (const { family, file } of Object.values(STATS_OUTRO_FONTS)) {
    document.fonts.add(new FontFace(family, `url(/fonts/title-card/${file})`, { weight: '100 900' }));
  }
}

// A gallery PNG has a small WebP beside it; the floor never needs the full still.
const floorSrc = (imageId) => (/\.png$/i.test(imageId)
  ? `/data/image-thumbnails/${encodeURIComponent(imageId.replace(/\.png$/i, '.webp'))}`
  : `/data/images/${encodeURIComponent(imageId)}`);

/**
 * The cutting room floor outro (lib/musicVideoStatsOutro.js) at scene time
 * `t`, painted by the same function the final render captures. `stats` is the
 * server's tally (null while it loads: the floor and plate draw, the numbers
 * read zero until it lands).
 */
export default function StatsOutroCanvas({ stats, t, durationSec }) {
  const canvasRef = useRef(null);
  const [images, setImages] = useState([]);
  const [fontsReady, setFontsReady] = useState(0);
  const floor = stats?.floorImages;

  useEffect(() => {
    addOutroFaces();
    let active = true;
    document.fonts?.load?.(`800 40px "${STATS_OUTRO_FONTS.head.family}"`)
      .then(() => document.fonts.load(`500 40px "${STATS_OUTRO_FONTS.body.family}"`))
      .then(() => { if (active) setFontsReady((n) => n + 1); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const loaded = (floor || []).map(() => null);
    setImages(loaded);
    (floor || []).forEach((imageId, i) => {
      const img = new Image();
      img.onload = () => {
        if (!active) return;
        loaded[i] = img;
        setImages([...loaded]);
      };
      img.src = floorSrc(imageId);
    });
    return () => { active = false; };
  }, [floor]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext?.('2d');
    if (!ctx) return;
    drawStatsOutro(ctx, { width: WIDTH, height: HEIGHT, t, durationSec, stats, images });
  }, [t, durationSec, stats, images, fontsReady]);

  return (
    <canvas
      ref={canvasRef}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label="Human directed: the choices behind this video, and what was left on the cutting room floor"
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-testid="animatic-stats-outro"
    />
  );
}
