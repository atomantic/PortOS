import Drawer from '../Drawer.jsx';
import SceneTakeStrip from './SceneTakeStrip.jsx';

/**
 * Project contact sheet (#8965): every scene's frame and clip takes side by
 * side, so the director can compare candidates across the whole video, pick
 * the ones the render uses, and reject the misses in one pass. Opened from the
 * board's handoff row; its open state lives in the URL (`?sheet=contact`).
 */
export default function ContactSheetDrawer({ open, onClose, project, busy, onSelectTake, onReviewTake, onOpenPreview }) {
  const scenes = project?.scenes || [];
  return (
    <Drawer open={open} onClose={onClose} title="Contact sheet" subtitle={project?.name} size="xl" closeLabel="Close contact sheet">
      {scenes.length === 0 && <p className="text-sm text-port-text-muted">No scenes yet.</p>}
      <ol className="space-y-3">
        {scenes.map((scene, index) => (
          <li key={scene.sceneId} className="rounded border border-port-border p-2 space-y-2">
            <div className="text-sm font-medium truncate">
              {index + 1}. {scene.sectionLabel || scene.label || `Scene ${index + 1}`}
            </div>
            {!(scene.takes?.length || scene.referenceImageId || scene.videoHistoryId) && (
              <p className="text-[11px] text-port-text-muted">No takes yet.</p>
            )}
            {['image', 'video'].map((kind) => (
              <SceneTakeStrip key={kind} scene={scene} kind={kind} busy={busy} large
                onSelect={(take) => onSelectTake(scene, take)}
                onReview={(take, review) => onReviewTake(scene, take, review)}
                onOpenPreview={onOpenPreview} />
            ))}
          </li>
        ))}
      </ol>
    </Drawer>
  );
}
