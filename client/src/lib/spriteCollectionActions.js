/**
 * Sprite asset-collection action resolvers (#2931).
 *
 * Decides, for one classified asset row, whether the collection card gets a
 * **Regenerate** button (and whether it is enabled) and an **Edit in Loop
 * Trimmer** button. Split out of the page so the gating — which is the whole
 * correctness surface of the feature — is unit-testable without mounting the
 * Sprite Manager and its API graph.
 *
 * Pure: takes the already-fetched record detail plus the caller's in-flight
 * maps and callbacks, and returns closures. It performs no I/O itself and
 * knows nothing about React, toasts, or `apiSprites`.
 *
 * The gating deliberately TRACKS the authoritative workflow surfaces rather
 * than inventing its own rules — a walk direction is regenerable on the same
 * finalized/approved/anchor-locked/in-flight conditions `WalkWorkflow` gates
 * its Generate button on, and an anchor re-roll mirrors `ReferenceWorkflow`'s
 * own backend-availability gate: when no image backend is configured the
 * button is disabled with the same guidance, rather than queuing a job that
 * fails with a toast (#2938). The selected backend `mode` is threaded from the
 * page (the same state `ReferenceWorkflow`'s picker drives) so a card re-roll
 * uses the same backend the workflow would, not a server default.
 */

// Roles that represent a walk run's rendered output. A manifest or a review
// sheet from the same run is not something you re-render on its own.
const WALK_OUTPUT_ROLES = new Set(['strip', 'animation', 'frame']);

/**
 * @param detail            the `/api/sprites/:id` payload (`{ record, reference, walk }`)
 * @param walkPending       direction → jobId map for in-flight walk videos
 * @param referencePending  target → jobId map for in-flight reference images
 * @param generateWalk      (direction) => void — fires the walk render
 * @param generateAnchor    (direction, mode) => void — fires the anchor render
 * @param onRequestTrim     (runId) => void — opens the Loop Trimmer for a run
 * @param hasBackend        whether an image backend is configured (gates the
 *                          anchor re-roll — defaults true so callers that don't
 *                          know the backend state keep the pre-#2938 behavior)
 * @param mode              the workflow-selected image backend id, threaded
 *                          into the anchor re-roll so it matches the workflow
 * @returns `{ regenerateFor(asset), trimFor(asset) }`, each returning null for
 *          an asset it can't act on. A reference regenerate also carries the
 *          asset's `direction` so the caller can bind an inline correction note
 *          to the shared per-direction corrections state (#2964).
 */
export function buildCollectionActions({
  detail, walkPending = {}, referencePending = {},
  generateWalk, generateAnchor, onRequestTrim,
  hasBackend = true, mode,
}) {
  const walk = detail?.walk || null;
  const finalized = Boolean(walk?.walkSet);
  const approvedDirections = walk?.selection?.directions || {};
  const anchors = detail?.reference?.manifest?.anchors || [];
  const lockedDirections = new Set(
    anchors.filter((a) => a.status === 'locked').map((a) => a.direction),
  );
  const knownDirections = new Set(anchors.map((a) => a.direction));
  // Any run that packed a strip can be trimmed: the trim service resolves the
  // run by id and derives geometry from its own manifest/stripPreview
  // regardless of on-disk layout (native `runs/`, legacy `grok/`, imported
  // `runs/`, or an imagegen redraw), so the gate is strip PRESENCE, not a
  // vendor-directory prefix.
  const trimmableRunIds = new Set(
    (walk?.runs || [])
      .filter((r) => r?.stripPreview?.stripPath)
      .map((r) => r.id),
  );

  const regenerateFor = (asset) => {
    const { role, direction, runId, status } = asset?.facets || {};
    if (!direction || !knownDirections.has(direction)) return null;

    if (runId && WALK_OUTPUT_ROLES.has(role)) {
      const approved = approvedDirections[direction]?.status === 'approved';
      const locked = lockedDirections.has(direction);
      const pending = Boolean(walkPending[direction]);
      return {
        kind: 'walk',
        pending,
        disabled: finalized || approved || !locked || pending,
        title: finalized ? 'The walk set is finalized — regenerating is disabled'
          : approved ? 'This direction is already approved'
            : !locked ? "Lock this direction's reference anchor first"
              : 'Re-render this direction\'s walk cycle',
        onClick: () => generateWalk(direction),
      };
    }

    // A directional reference CANDIDATE can be re-rolled; an approved/superseded
    // anchor file only exists after the lock, and locks are irreversible.
    // `south` is excluded because the main reference is derived from the
    // turnaround sheet in ReferenceWorkflow's guided flow, and a DIRECTIONLESS
    // candidate (the turnaround sheet itself, #2979) has no direction to
    // re-roll — it carries the design prompt and seed sources, which an asset
    // card can't supply. Both stay in ReferenceWorkflow.
    if (role === 'reference' && status === 'candidate' && direction && direction !== 'south') {
      const locked = lockedDirections.has(direction);
      const pending = Boolean(referencePending[direction]);
      return {
        kind: 'reference',
        // Surfaced so the asset card can bind an inline correction note to the
        // shared per-direction corrections state (#2964) — the same note the
        // ReferenceWorkflow anchor grid shows — before firing generateAnchor.
        direction,
        pending,
        disabled: !hasBackend || locked || pending,
        title: !hasBackend
          ? 'No image backend configured — enable one in Settings → Image Gen'
          : locked ? 'This anchor is locked — its reference set is frozen' : 'Render another candidate for this anchor',
        onClick: () => generateAnchor(direction, mode),
      };
    }

    return null;
  };

  const trimFor = (asset) => {
    const { role, runId } = asset?.facets || {};
    if (!runId || !WALK_OUTPUT_ROLES.has(role) || !trimmableRunIds.has(runId)) return null;
    return { onClick: () => onRequestTrim(runId) };
  };

  return { regenerateFor, trimFor };
}
