/**
 * Creative Commission — output surfacing (#2657, Phase 2 — Autonomous Creation
 * Engine feedback loop).
 *
 * When a scheduled commission fires and mints a run, surface it so the user
 * knows a new piece is being created and can rate it once it lands. Surfacing is
 * BEST-EFFORT and MUST NOT throw into the scheduler's fire handler — that handler
 * runs outside the Express request lifecycle, where an uncaught throw crashes
 * Node.
 *
 * WHY NOTIFICATION-ONLY (not the brain inbox). Commissions are machine-local in
 * Phase 1/2 (a synced schedule would double-run on every peer — see store.js).
 * The `notifications` store is a local file (never federated), so a
 * commission-scoped, machine-local `/creative-commission/:id` deep link belongs
 * there. The brain inbox, by contrast, IS federated (`inbox` ∈
 * `BRAIN_ENTITY_TYPES`) — writing a reminder there would propagate a
 * `needs_review` item pointing at a commission that doesn't exist on the peer,
 * polluting its backlog. Brain-inbox surfacing rejoins once commissions
 * themselves federate (the split-record follow-up, #2686).
 *
 * WHY "fired / generating" wording (not "created a result"). Surfacing happens
 * at fire time — the CD project has only just been created; generation runs
 * asynchronously afterward. The copy therefore describes a run that is *being
 * created* and invites the user to rate it once it lands, rather than claiming a
 * finished artifact already exists. (Completion-triggered surfacing + catalog
 * seeding is the Phase 3 completion flow.)
 *
 * The notifications module is lazy-imported so this stays a light leaf a mocked
 * test suite can stub without dragging its graph in.
 */

/**
 * Surface a freshly-fired commission run via a local notification.
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
      title: `“${name}” is creating a new ${ability}`,
      description: 'Your standing commission fired — rate the result once it lands to steer the next run.',
      priority: PRIORITY_LEVELS.LOW,
      link,
      metadata: { commissionId: commission.id, runId: run.id, projectId: run.projectId || null },
    });
  } catch (err) {
    console.error(`❌ Commission notification surface failed (${commission.id}): ${err?.message || err}`);
  }
}
