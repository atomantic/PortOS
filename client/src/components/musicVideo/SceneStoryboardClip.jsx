import { Activity, Clapperboard, ImageIcon } from 'lucide-react';
import { musicVideoPanelArtReferences } from '../../../../server/lib/musicVideoConditioning.js';
import { storyboardClipBlockedReason } from '../../../../server/lib/storyboardGuidance.js';

const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';

/**
 * Whether a shot's card leads with "Clip from storyboard": a footage cutaway
 * fitted from a storyboard panel whose still is not locked. The panel is sent as
 * layout guidance only and the shot's references set the look; the lane builds
 * its own photographic first frame (lib/storyboardGuidance.js).
 */
export const storyboardClipOffered = ({ scene, layer, performance, stillLocked }) => layer === 'footage' && !performance
  && !stillLocked && musicVideoPanelArtReferences(scene).length > 0;

/**
 * "Clip from storyboard", and, while the shot has no still, the one-tap
 * "Render full still first" that makes the still the regular Render animates.
 * `refusal` is what else holds the render back (saving, locked clip, a render
 * already running); the lane check is this component's own.
 */
export default function SceneStoryboardClip({ backend, refusal = null, generatingVideo = false, generatingFrame = false, hasStill = false, onClip, onStill }) {
  const blocked = refusal || storyboardClipBlockedReason({ backend });
  return (
    <>
      <button type="button" onClick={onClip} disabled={!!blocked} className={PRIMARY_BUTTON}
        title={blocked || 'Render the clip from the storyboard panel: the panel sets the framing and blocking, the shot\'s references set the look'}>
        {generatingVideo ? <Activity size={14} className="animate-spin" /> : <Clapperboard size={14} />}
        {generatingVideo ? 'Rendering…' : 'Clip from storyboard'}
      </button>
      {!hasStill && onStill && (
        <button type="button" onClick={onStill} disabled={generatingFrame} className={SECONDARY_BUTTON}
          title="Render the shot's full still from the panel and its references first, then render the clip from that still">
          {generatingFrame ? <Activity size={14} className="animate-spin" /> : <ImageIcon size={14} />}
          {generatingFrame ? 'Rendering still…' : 'Render full still first'}
        </button>
      )}
      {blocked && <span className="w-full text-[11px] text-port-warning" data-testid="storyboard-clip-refusal">{blocked}</span>}
    </>
  );
}
