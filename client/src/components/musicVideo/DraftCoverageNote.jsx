import { finalTierCounts } from '../../../../server/lib/musicVideoFinalApproval.js';
import { scenePlayableClipId } from '../../../../server/lib/musicVideoSourceTake.js';
import { isLayeredComposition, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import { shotNumbers } from './ShotStepper.jsx';

/** Footage shots with no clip to play yet (a return playing another shot's clip has one). */
function shotsWithoutClip(project) {
  const scenes = project?.scenes || [];
  const layered = isLayeredComposition(project);
  return scenes.filter((scene) => sceneVisualLayer(scene, { layered }) === 'footage' && !scenePlayableClipId(scene, scenes));
}

/**
 * Under the whole-video preview (#16136): how many shots play a draft or a final
 * clip, and which footage shots have no clip yet, each a link to its shot. The
 * preview plays every shot's selected take whatever its tier; this says what is missing.
 */
export default function DraftCoverageNote({ project, collapsed = false, onEditShot = null }) {
  const missing = shotsWithoutClip(project);
  const counts = finalTierCounts(project?.scenes);
  if (!missing.length && !counts.draft && !counts.final) return null;
  const numbers = shotNumbers(project.scenes);
  return (
    <div className={`min-w-0 space-y-1 text-xs text-port-text-muted ${collapsed ? 'max-xl:hidden' : ''}`} data-testid="draft-coverage">
      <p>{counts.draft} draft · {counts.final} final clip{counts.final === 1 ? '' : 's'} in this preview.</p>
      {missing.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-port-warning">No clip yet:</span>
          {missing.map((scene) => {
            const label = sceneShotName(scene, { number: numbers.get(scene.sceneId) });
            return onEditShot ? (
              <button key={scene.sceneId} type="button" onClick={() => onEditShot(scene.sceneId)}
                className="min-h-[44px] rounded border border-port-border px-1.5 py-0.5 hover:bg-port-border/40 pointer-fine:sm:min-h-0">{label}</button>
            ) : <span key={scene.sceneId}>{label}</span>;
          })}
        </div>
      )}
    </div>
  );
}
