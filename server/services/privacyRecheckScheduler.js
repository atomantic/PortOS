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

import { schedule, cancel, parseCronToNextRun } from './eventScheduler.js';
import { getSettings } from './settings.js';
import { getUserTimezone } from './userTimezone.js';
import { runScanPass } from './privacyScan.js';
import { runOptOutPass } from './privacyOptOut.js';
import { listSubjects } from './privacySubjects.js';

const EVENT_ID = 'privacy-recheck';
const DEFAULT_CRON = '0 4 * * 0'; // weekly, Sun 4am

export async function startPrivacyRecheckScheduler() {
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
    handler: async () => {
      const current = await getSettings();
      if (current.privacy?.recheck?.enabled !== true) {
        console.log('🛡️ Privacy recheck: disabled since registration — skipping run');
        return;
      }
      // Run for EVERY consenting subject, not just `self` — a household member
      // added to the Privacy Center gets the same scheduled upkeep (#3658). A
      // subject with no consent row is skipped here (the engines would refuse
      // them anyway); one subject's failure must not abort the others, and this
      // handler runs OUTSIDE the request lifecycle, so the per-subject try/catch
      // is the sanctioned exception to the no-try/catch rule.
      const subjects = await listSubjects();
      const consenting = subjects.filter((s) => (s.consentCount ?? 0) > 0);
      console.log(`🛡️ Privacy recheck: running scheduled scan + opt-out pass for ${consenting.length} consenting subject(s)`);
      for (const subject of consenting) {
        try {
          // Scan first (re-checks due cases + finds new exposure), then work the
          // cases. Both are settings-driven and safe to re-run (idempotent).
          await runScanPass({ subjectId: subject.id });
          await runOptOutPass({ subjectId: subject.id });
        } catch (err) {
          console.error(`❌ Privacy recheck failed for subject ${subject.id}: ${err.message}`);
        }
      }
    },
    metadata: { source: 'privacyRecheckScheduler' },
  });

  console.log(`🛡️ Privacy recheck scheduler: registered at cron "${cronExpression}"`);
}

export function stopPrivacyRecheckScheduler() {
  cancel(EVENT_ID);
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
  };
}
