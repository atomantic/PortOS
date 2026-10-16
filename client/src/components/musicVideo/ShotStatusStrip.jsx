import { useContext } from 'react';
import { Link } from 'react-router';
import { ShotLockContext, overallShotLock, shotUnlocked } from './ShotLock.jsx';
import { SCENE_ATTENTION_LABELS, sceneAttention } from '../../lib/musicVideoSceneAttention.js';

/**
 * One compact cell per shot, from the same `sceneAttention` answer the Board's
 * scene rows use: green when nothing needs doing, amber otherwise, with the
 * reasons in the tooltip. Each cell opens that scene on the Storyboard. A
 * locked shot is settled, as on the Board: its other takes are not waiting.
 */
export default function ShotStatusStrip({ projectId, scenes, ctx }) {
  const lockValue = useContext(ShotLockContext);
  if (!scenes?.length) return null;
  const locked = (scene) => !!lockValue?.locks?.[scene.sceneId]
    && overallShotLock(lockValue.locks[scene.sceneId], lockValue.clips?.[scene.sceneId]) === 'locked';
  const cells = scenes.map((scene) => ({ scene, codes: sceneAttention(scene, { ...ctx, locked: locked(scene), unlocked: shotUnlocked(lockValue, scene.sceneId) }) }));
  return (
    <ul aria-label="Shot status" className="flex flex-wrap gap-1">
      {cells.map(({ scene, codes }) => {
        const label = codes.map((code) => SCENE_ATTENTION_LABELS[code]).join(', ');
        return (
          <li key={scene.sceneId}>
            <Link
              to={`/music-video/${encodeURIComponent(projectId)}/board/scene/${encodeURIComponent(scene.sceneId)}`}
              data-status={codes.length ? 'attention' : 'ready'}
              title={`Scene ${scene.order + 1}: ${label || 'ready'}`}
              aria-label={`Scene ${scene.order + 1}: ${label || 'ready'}`}
              className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded border text-[11px] sm:min-h-0 sm:min-w-[28px] sm:px-1 sm:py-0.5 ${codes.length ? 'border-port-warning/40 bg-port-warning/10 text-port-warning' : 'border-port-success/40 bg-port-success/10 text-port-success'}`}
            >
              {scene.order + 1}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
