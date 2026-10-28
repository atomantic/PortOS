/**
 * Privacy broker opt-out recheck scheduler (issue #2145, epic #2138).
 *
 * Registers a cron that re-runs the exposure scan + opt-out pass + verification
 * over due broker cases. OFF by default — the user turns it on from the Privacy
 * UI (settings `privacy.recheck.enabled`). This is the SANCTIONED scheduled-
 * automation exception to the no-cold-bootstrap AI-provider policy: the user
 * explicitly configured it, so it may drive the engine (and any LLM inside it)
 * on its own schedule. Mirrors backupScheduler.js.
 *
 * The cron expression is locked in at registration; enabled/autonomy toggles are
 * re-read inside the handler so a Settings save takes effect on the next run
 * without a restart.
 */

import { schedule, cancel, parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js';
import { getSettings, updateSettingsWith } from './settings.js';
import { getUserTimezone } from './userTimezone.js';
import { runScanPass } from './privacyScan.js';
import { runOptOutPass } from './privacyOptOut.js';
import { listSubjects } from './privacySubjects.js';

const EVENT_ID = 'privacy-recheck';
const CATCHUP_EVENT_ID = 'privacy-recheck-missed-slot-catchup';
const DEFAULT_CRON = '0 4 * * 0'; // weekly, Sun 4am

// Boot delay before a missed-slot catch-up runs, mirroring backupScheduler.js
// (#8456): stays clear of boot-time migrations and store warm-up.
const CATCHUP_BOOT_DELAY_MS = 5 * 60_000;

// At most one catch-up evaluation per process boot.
let catchUpEvaluated = false;

const toMs = (iso) => {
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
};

/** Settings-gated run shared by the cron handler and the missed-slot catch-up. */
async function runIfEnabled(logReason) {
  const current = await getSettings();
  if (current.privacy?.recheck?.enabled !== true) {
    console.log(`🛡️ Privacy recheck: disabled since registration — skipping ${logReason} run`);
    return;
  }
  await runScheduledRecheck();
}

/**
 * If the latest cron slot elapsed without a recheck (server down across it),
 * schedule one catch-up after a boot delay — however many slots were missed.
 * With no `lastRunAt` yet, only a slot after `enabledAt` counts as missed, so
 * enabling the feature never replays a slot that predates it.
 */
function maybeCatchUpMissedSlot(recheck, cronExpression, timezone) {
  if (catchUpEvaluated) return;
  catchUpEvaluated = true;
  const prevRun = parseCronToPrevRun(cronExpression, new Date(), timezone);
  if (!prevRun) return;
  const prevRunMs = prevRun.getTime();
  const lastRunMs = toMs(recheck.lastRunAt);
  const enabledAtMs = toMs(recheck.enabledAt);
  if (Number.isFinite(lastRunMs) ? lastRunMs >= prevRunMs : !(enabledAtMs < prevRunMs)) return;

  console.log(`🛡️ Privacy recheck scheduler: missed slot ${prevRun.toISOString()} — catching up in ${Math.round(CATCHUP_BOOT_DELAY_MS / 60_000)}m`);
  schedule({
    id: CATCHUP_EVENT_ID,
    type: 'once',
    delayMs: CATCHUP_BOOT_DELAY_MS,
    handler: () => runIfEnabled('missed-slot catch-up'),
    metadata: { source: 'privacyRecheckScheduler' },
  });
}

/**
 * @param {object} [options]
 * @param {boolean} [options.catchUpMissedSlot] - boot only; a settings-save
 *   restart must not replay a slot the user did not miss.
 */
export async function startPrivacyRecheckScheduler({ catchUpMissedSlot = false } = {}) {
  const settings = await getSettings();
  const recheck = settings.privacy?.recheck || {};

  if (recheck.enabled !== true) {
    console.log('🛡️ Privacy recheck scheduler: disabled in settings — skipping');
    return;
  }

  const cronExpression = recheck.cronExpression || DEFAULT_CRON;
  const timezone = await getUserTimezone();

  schedule({
    id: EVENT_ID,
    type: 'cron',
    cron: cronExpression,
    timezone,
    handler: () => runIfEnabled('scheduled'),
    metadata: { source: 'privacyRecheckScheduler' },
  });

  console.log(`🛡️ Privacy recheck scheduler: registered at cron "${cronExpression}"`);
  if (catchUpMissedSlot) maybeCatchUpMissedSlot(recheck, cronExpression, timezone);
}

// Each scheduled purpose, in run order: scan first (re-checks due cases + finds
// new exposure), then work the cases. Both passes are settings-driven and safe
// to re-run (idempotent).
const SCHEDULED_PURPOSES = [
  { scope: 'broker_scan', label: 'scan', run: runScanPass },
  { scope: 'broker_optout', label: 'opt-out', run: runOptOutPass },
];

/**
 * One scheduled recheck over every subject, not just `self` — a household
 * member gets the same upkeep (#3658). Subjects are selected PER PURPOSE from
 * their active grants (#8332): a `broker_scan`-only subject is scanned but
 * never submitted, a `pii_vault`-only (or fully revoked) subject gets neither.
 * The engines re-check the grant themselves, so a revocation racing this loop
 * is still refused. One subject's or purpose's failure must not abort the
 * others, and this runs OUTSIDE the request lifecycle, so the per-pass
 * try/catch is the sanctioned exception to the no-try/catch rule.
 * The cron handler calls it after the enabled check.
 */
async function runScheduledRecheck() {
  const subjects = await listSubjects();
  for (const { scope, label, run } of SCHEDULED_PURPOSES) {
    const granted = subjects.filter((s) => (s.activeScopes ?? []).includes(scope));
    console.log(`🛡️ Privacy recheck: ${label} pass for ${granted.length}/${subjects.length} subject(s) with active ${scope} consent`);
    for (const subject of granted) {
      try {
        await run({ subjectId: subject.id });
      } catch (err) {
        console.error(`❌ Privacy recheck ${label} failed for subject ${subject.id}: ${err.message}`);
      }
    }
  }
  // Stamped on completion, partial failures included (they are isolated above).
  await updateSettingsWith((current) => ({
    ...current,
    privacy: {
      ...(current.privacy || {}),
      recheck: { ...(current.privacy?.recheck || {}), lastRunAt: new Date().toISOString() },
    },
  }));
}

export function stopPrivacyRecheckScheduler() {
  cancel(EVENT_ID);
  cancel(CATCHUP_EVENT_ID);
  console.log('🛡️ Privacy recheck scheduler: stopped');
}

/**
 * Restart the scheduler so a Settings save (enable/disable, new cron) takes
 * effect immediately without a server restart — the cron expression is locked
 * in at registration, so a change needs a cancel + re-register. Called by the
 * PUT /api/privacy/optout/schedule route after it persists the settings slice.
 */
export async function restartPrivacyRecheckScheduler() {
  stopPrivacyRecheckScheduler();
  await startPrivacyRecheckScheduler();
}

/**
 * Read-only schedule status for the Brokers-tab run controls: whether the cron
 * is enabled, its expression, the autonomy toggles, and the next fire time
 * (null when disabled or the cron can't be parsed). Never triggers work.
 */
export async function getPrivacyRecheckStatus() {
  const settings = await getSettings();
  const recheck = settings.privacy?.recheck || {};
  const enabled = recheck.enabled === true;
  const cronExpression = recheck.cronExpression || DEFAULT_CRON;
  const timezone = await getUserTimezone();
  let nextRun = null;
  if (enabled) {
    // parseCronToNextRun returns null on an unparseable expression — never throw.
    nextRun = parseCronToNextRun(cronExpression, new Date(), timezone)?.toISOString?.() ?? null;
  }
  return {
    enabled,
    cronExpression,
    autoApproveOptOutEmails: recheck.autoApproveOptOutEmails === true,
    autoSubmitWebForms: recheck.autoSubmitWebForms === true,
    nextRun,
    lastRunAt: recheck.lastRunAt ?? null,
  };
}

/** Test seam: allow another boot-time catch-up evaluation in the same process. */
export function __resetCatchUpForTests() {
  catchUpEvaluated = false;
}
