import { currentPlateEvidence } from '../../../../server/lib/musicVideoPlateEvidence.js';
import { sceneTakeList, takeThumbUrl } from '../../lib/musicVideoTakes.js';

/**
 * Short verdict of a frame take's current plate check, or null when no check has
 * run for this image and shot as they are now: an unchecked take wears no badge.
 * `issues` are the other checks that did not pass, to show when the badge is opened.
 */
export function plateVerdict(scene, take) {
  if (!scene) return null;
  const evidence = currentPlateEvidence(scene, take);
  if (!evidence) return null;
  // A failed render-quality check has its own line and acknowledgement on the take card.
  const issues = evidence.checks.filter((check) => check.status !== 'pass' && !(check.id === 'render-quality' && check.status === 'fail'));
  if (evidence.verdict === 'pass') return { label: 'Checked', tone: 'pass', issues };
  if (evidence.verdict === 'fail') return { label: 'Issues', tone: 'fail', issues };
  return { label: 'Unclear', tone: 'unverified', issues };
}

/**
 * Selected and candidate plates share the same asset/intent evidence boundary.
 * `frames={false}` omits the thumbnails for a card whose take strip already
 * shows each frame once with a verdict badge; only the evidence notes remain.
 */
export default function PlateComparison({ scene, frames = true }) {
  if (!scene) return null;
  const takes = sceneTakeList(scene, 'image');
  return (
    <section aria-label="Plate preflight comparison" className="space-y-2 rounded border border-port-border p-2">
      <p className="text-xs text-port-text-muted">Plate preflight · starting-state evidence before production animation</p>
      {!takes.length && <p className="text-xs text-port-warning">No plate selected. Generate or import a frame before preflight.</p>}
      <ul className="flex gap-3 overflow-x-auto pb-1">
        {takes.map((take) => {
          const evidence = currentPlateEvidence(scene, take);
          const selected = take.assetId === scene.referenceImageId;
          return (
            <li key={take.assetId} className={`${frames ? 'w-48' : 'w-56'} shrink-0 space-y-1`}>
              {frames && <img src={takeThumbUrl(take)} alt={`${selected ? 'Selected' : 'Candidate'} plate`} className="aspect-video w-full rounded object-cover" loading="lazy" />}
              <p className="text-xs font-medium break-words">{selected ? 'Selected' : 'Candidate'} · {evidence?.verdict === 'pass' ? 'Ready' : evidence?.verdict === 'fail' ? 'Requirements unmet' : 'Unverified'}</p>
              {!evidence && <p className="text-xs text-port-warning">{take.plateEvidence ? 'Shot requirements changed. Review this plate again.' : 'Production has not reviewed this plate.'}</p>}
              {evidence && <ul className="space-y-1 text-[11px]">
                {evidence.checks.filter((check) => check.status !== 'pass').map((check) => <li key={check.id} className="text-port-warning break-words">{check.requirement}: {check.note}</li>)}
                {evidence.verdict === 'pass' && <li className="text-port-text-muted">All visible starting-state requirements verified.</li>}
              </ul>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
