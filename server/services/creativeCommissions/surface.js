/**
 * Creative Commission — output surfacing (#2657, Phase 2 — Autonomous Creation
 * Engine feedback loop).
 *
 * When a scheduled commission fires and mints a run, surface it so the user
 * knows a new piece is being created and can rate it once it lands: a
 * notification (deep-linked to the commission, where the run's rate/annotate
 * control lives) plus a brain inbox entry. Both are BEST-EFFORT and MUST NOT
 * throw into the scheduler's fire handler — that handler runs outside the
 * Express request lifecycle, where an uncaught throw crashes Node.
 *
 * Policy note (CLAUDE.md AI Provider Usage Policy): the brain entry is created
 * with `createInboxLog` directly and NO `ai` metadata, so it lands in the inbox
 * for manual review WITHOUT triggering a background classifier LLM call. The
 * commission generation itself is the sanctioned scheduled trigger; surfacing it
 * must not tack on an unrequested provider call.
 *
 * The heavy deps (notifications, brainStorage) are lazy-imported so this stays a
 * light leaf that a mocked test suite can stub without dragging their graphs in.
 */

/**
 * Surface a freshly-fired commission run via notification + brain inbox.
 * @param {object} commission sanitized commission record
 * @param {object} run the run entry just recorded (from recordCommissionRun)
 */
export async function surfaceCommissionRun(commission, run) {
  if (!commission?.id || !run) return;
  const link = `/creative-commission/${encodeURIComponent(commission.id)}`;
  const ability = commission.targetAbility || 'video';
  const name = commission.name || 'Commission';

  try {
    const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('../notifications.js');
    await addNotification({
      type: NOTIFICATION_TYPES.CREATIVE_COMMISSION,
      title: `New ${ability} from “${name}”`,
      description: 'Your standing commission fired — rate the result to steer the next run.',
      priority: PRIORITY_LEVELS.LOW,
      link,
      metadata: { commissionId: commission.id, runId: run.id, projectId: run.projectId || null },
    });
  } catch (err) {
    console.error(`❌ Commission notification surface failed (${commission.id}): ${err?.message || err}`);
  }

  try {
    const { createInboxLog } = await import('../brainStorage.js');
    await createInboxLog({
      capturedText: `Creative commission “${name}” created a new ${ability}. Rate it to steer the next run: ${link}`,
      source: 'creative_commission',
      creative: true,
      status: 'needs_review',
    });
  } catch (err) {
    console.error(`❌ Commission brain-inbox surface failed (${commission.id}): ${err?.message || err}`);
  }
}
