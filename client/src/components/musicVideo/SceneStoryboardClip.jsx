import { Activity, Clapperboard, ImageIcon } from 'lucide-react';
import { musicVideoPanelArtReferences } from '../../../../server/lib/musicVideoConditioning.js';

const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';

/**
 * Whether a shot's card leads with "Clip from storyboard": a footage cutaway
 * fitted from a storyboard panel that has no still yet. That tap renders the
 * shot's real still from the panel and its cast and set references, then the
 * server animates it (musicVideoSceneImageHook), so likeness comes from the
 * still renderer rather than from a video model editing the sketch.
 */
export const storyboardClipOffered = ({ scene, layer, performance }) => layer === 'footage' && !performance
  && !scene.referenceImageId && musicVideoPanelArtReferences(scene).length > 0;

/**
 * "Clip from storyboard" (still, then its clip) and "Still only" (the still to
 * review before animating it). `refusal` is what holds the clip back (saving,
 * a lane that is off).
 */
export default function SceneStoryboardClip({ refusal = null, generatingFrame = false, onClip, onStill }) {
  return (
    <>
      <button type="button" onClick={onClip} disabled={!!refusal || generatingFrame} className={PRIMARY_BUTTON}
        title={refusal || "Render the shot's still from the panel and its references, then animate that still"}>
        {generatingFrame ? <Activity size={14} className="animate-spin" /> : <Clapperboard size={14} />}
        {generatingFrame ? 'Rendering still…' : 'Clip from storyboard'}
      </button>
      {onStill && (
        <button type="button" onClick={onStill} disabled={generatingFrame} className={SECONDARY_BUTTON}
          title="Render only the shot's still, to review it before rendering its clip">
          <ImageIcon size={14} /> Still only
        </button>
      )}
      {refusal && <span className="w-full text-[11px] text-port-warning" data-testid="storyboard-clip-refusal">{refusal}</span>}
    </>
  );
}
