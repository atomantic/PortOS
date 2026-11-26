import { ImagePlus, Loader2 } from 'lucide-react';
import MediaImage from '../MediaImage';

export default function LoomSceneStillSlot({ node, title, activeKind, liveFrame, generating, compact, previewItemClass }) {
  const mediaClass = `${previewItemClass} block h-full w-full object-cover`;
  return liveFrame ? (
    <img
      src={`data:image/png;base64,${liveFrame}`}
      alt={`${title} ${activeKind} generation preview`}
      className={mediaClass}
    />
  ) : node.image ? (
    <MediaImage
      src={`/data/images/${node.image}`}
      alt={`${title} image preview`}
      className={mediaClass}
    />
  ) : generating ? (
    <div className={`${previewItemClass} grid h-full min-h-16 place-items-center text-port-accent`}>
      <Loader2 size={compact ? 16 : 22} className="animate-spin" aria-hidden="true" />
    </div>
  ) : (
    <div className={`${previewItemClass} flex h-full min-h-16 flex-col items-center justify-center gap-1 text-port-text-muted`}>
      <ImagePlus size={compact ? 15 : 22} aria-hidden="true" />
      <span className={compact ? 'text-[9px]' : 'text-xs'}>No scene media yet</span>
    </div>
  );
}
