/**
 * Creative Commission output surfacing (#2657): tell the user a scheduled commission fired and can be rated
 * once it lands. BEST-EFFORT and MUST NOT throw into the scheduler's fire handler, which runs outside the
 * Express request lifecycle.
 *
 * Notification-only, not the brain inbox: commissions are machine-local (see store.js) and the
 * `notifications` store never federates, whereas the inbox does, so a reminder there would put a
 * `needs_review` item for a nonexistent commission on every peer. Inbox surfacing rejoins once commissions
 * federate (#2686).
 *
 * Wording is "fired / generating": at fire time the CD project has just been created and generation is
 * asynchronous, so the copy must not claim a finished artifact exists.
 *
 * The notifications module is lazy-imported so this stays a light leaf a mocked suite can stub.
 */

/**
 * Surface a freshly-fired commission run via a local notification.
 * @param {object} commission sanitized commission record
 * @param {object} run the run entry just recorded (from recordCommissionRun)
 */
export async function surfaceCommissionRun(commission, run) {
  if (!commission?.id || !run) return;
  // Scope the deep link to THIS run (`?run=<runId>`): the gallery is newest-first, so a later run would push the announced render down.
  const link = run.id
    ? `/creative-commission/${encodeURIComponent(commission.id)}?run=${encodeURIComponent(run.id)}`
    : `/creative-commission/${encodeURIComponent(commission.id)}`;
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

/**
 * Surface a run-history write that FAILED (#7529), the degraded twin of surfaceCommissionRun.
 * A cron tick has no HTTP response to carry `historyWarning`, so for the unattended case a log line would be
 * the only signal. MEDIUM priority (not LOW): nothing retries and the run row is gone, so the deep link to
 * the Creative Director project is the only route to the running work.
 *
 * Best-effort: never throws into the scheduler's fire handler. The notification names the commission (the
 * store is machine-local and never federates) but must NOT carry the directive, prompt or feedback; the
 * metadata is local ids plus the bounded classification.
 *
 * @param {object} commission sanitized commission record, or `{ id }` when the record could not be read
 * @param {object} warning the `historyWarning` persistRun produced
 */
export async function surfaceCommissionHistoryLoss(commission, warning) {
  if (!commission?.id || !warning) return;
  const name = commission.name || 'A commission';
  const link = warning.projectId
    ? `/creative-director/${encodeURIComponent(warning.projectId)}`
    : `/creative-commission/${encodeURIComponent(commission.id)}`;
  const body = warning.projectId
    ? 'The project is running, but this run was not saved to the commission’s history — it will not appear there or be ratable. Open the project to find the work.'
    : 'The outcome of this fire was not saved to the commission’s history.';

  try {
    const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('../notifications.js');
    await addNotification({
      type: NOTIFICATION_TYPES.CREATIVE_COMMISSION,
      title: `“${name}” could not save its run history`,
      description: body,
      priority: PRIORITY_LEVELS.MEDIUM,
      link,
      metadata: {
        commissionId: commission.id,
        projectId: warning.projectId || null,
        historyWarning: warning.code,
        outcome: warning.outcome,
        trigger: warning.trigger,
        detail: warning.detail,
      },
    });
  } catch (err) {
    console.error(`❌ Commission history-loss surface failed (${commission.id}): ${err?.message || err}`);
  }
}
