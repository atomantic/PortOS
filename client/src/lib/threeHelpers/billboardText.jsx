// Rasterizes a centered, bottom-anchored goal label with its bundled font into a scene-owned canvas texture.
import { useEffect, useMemo, useState } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';

const PIXELS_PER_EM = 64;

function labelTexture(text, family, maxEm, color, outline, strokeEm) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const setFont = () => { context.font = `${PIXELS_PER_EM}px "${family}", monospace`; };
  setFont();
  const maxPixels = maxEm * PIXELS_PER_EM;
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > maxPixels) {
      lines.push(line);
      line = '';
    }
    for (const char of (line ? ' ' : '') + word) {
      if (line && context.measureText(line + char).width > maxPixels) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
  }
  lines.push(line);
  const padding = Math.ceil(strokeEm * PIXELS_PER_EM) + 2;
  const lineHeight = PIXELS_PER_EM * 1.25;
  canvas.width = Math.ceil(Math.max(1, ...lines.map(item => context.measureText(item).width))) + 2 * padding;
  canvas.height = Math.ceil(lineHeight * lines.length) + 2 * padding;
  setFont(); // Resizing a canvas resets the 2D drawing state.
  context.fillStyle = color;
  context.strokeStyle = outline;
  context.lineWidth = 2 * strokeEm * PIXELS_PER_EM;
  context.lineJoin = 'round';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  lines.forEach((item, index) => {
    const y = padding + (index + 0.5) * lineHeight;
    context.strokeText(item, canvas.width / 2, y);
    context.fillText(item, canvas.width / 2, y);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function BillboardText({ ref, fontFamily, children, fontSize, maxWidth, color, outlineWidth, outlineColor, raycast }) {
  const [loadedFamily, setLoadedFamily] = useState(null);
  useEffect(() => {
    let active = true;
    document.fonts.load(`${PIXELS_PER_EM}px "${fontFamily}"`).then(() => {
      if (active) setLoadedFamily(fontFamily);
    }, () => {}); // The fallback label remains readable if the font is unavailable.
    return () => { active = false; };
  }, [fontFamily]);
  const texture = useMemo(() => labelTexture(children, loadedFamily || 'monospace', maxWidth / fontSize, color, outlineColor, outlineWidth / fontSize),
    [children, loadedFamily, maxWidth, fontSize, color, outlineColor, outlineWidth]);
  useEffect(() => () => texture.dispose(), [texture]);
  const width = texture.image.width * fontSize / PIXELS_PER_EM;
  const height = texture.image.height * fontSize / PIXELS_PER_EM;
  return <mesh position={[0, height / 2, 0]} raycast={raycast}>
    <planeGeometry args={[width, height]} />
    <meshBasicMaterial ref={ref} map={texture} transparent depthWrite={false} toneMapped={false} />
  </mesh>;
}
