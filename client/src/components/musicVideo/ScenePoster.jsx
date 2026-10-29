import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { scenePosterSrc } from '../../lib/musicVideoPreview.js';

/**
 * A scene's picture on the board: its frame, else its clip's poster, else (or
 * when the poster is missing) a placeholder icon. `src` overrides the picture
 * (Plan shows the storyboard panel). `className` sizes both.
 */
export default function ScenePoster({ scene, src = scenePosterSrc(scene), className = '', iconSize = 22 }) {
  const [failed, setFailed] = useState(null);
  if (src && failed !== src) return <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} className={`object-cover ${className}`} />;
  return <span className={`flex items-center justify-center bg-port-bg text-port-text-muted ${className}`}><ImageIcon size={iconSize} aria-hidden="true" /></span>;
}
