/** Start configured schedulers, timers, and their startup recovery in registration order. */

import { startIdleReaper } from '../../lib/managedDaemon.js';
import { armCommissionScheduler } from '../bootstrapSequence.js';
import { startBackupScheduler } from '../backupScheduler.js';
import { startAutoUpdateScheduler } from '../autoUpdateScheduler.js';
import { startPrivacyRecheckScheduler } from '../privacyRecheckScheduler.js';
import { startQuotaBurnScheduler } from '../quotaBurnRunner.js';
import { startMaintenanceRunScheduler } from '../maintenanceRun.js';
import { startNotificationResolveListener } from '../githubNotificationResolveTask.js';
import { startSeriesAutopilotScheduler } from '../seriesAutopilotScheduler.js';
import { startCommissionScheduler } from '../creativeCommissions/scheduler.js';
import { startBeeperScheduler } from '../beeper/beeperScheduler.js';
import { startEidoverseControllerSupervisor } from '../eidoverseControllerRuntime.js';
import { reconcileOutboxOnBoot } from '../beeper/beeperOutbox.js';
import { startBeeperSocket } from '../beeper/beeperSocket.js';
import { startImessageScheduler } from '../imessageScheduler.js';
import { startSignalScheduler } from '../signalScheduler.js';
import { startSpotifyScheduler } from '../spotifyScheduler.js';
import { startYoutubeScheduler } from '../youtubeScheduler.js';
import { startActivityDigestScheduler } from '../activityDigestScheduler.js';
import { startTwinEnrichmentScheduler } from '../twinEnrichmentScheduler.js';
import { startOrphanShellGc } from '../importerOrphanGc.js';
import { startImageRefsGc } from '../imageRefsGc.js';
import { startImageCleanTmpGc } from '../imageCleanTmpGc.js';
import { startOrphanedPartialGc } from '../orphanedPartialGc.js';
import { startBeeperAttachmentGc } from '../beeper/beeperAttachmentGc.js';
import { startTribePurge } from '../tribePurge.js';
import { startScreenshotsGc } from '../screenshotsGc.js';
import { initBridge as initBrainMemoryBridge } from '../brainMemoryBridge.js';
import { initDrillCache } from '../meatspace/meatspacePostDrillCache.js';
import { registerPostReminderSchedule } from '../meatspace/meatspacePostReminder.js';
import { registerAutobiographyReminderSchedule } from '../autobiographyReminder.js';
import { backfillAllCommissionFeedback } from '../creativeCommissions/store.js';
import { backfillProjectCommissionIds } from '../creativeCommissions/projectControl.js';
import { logFailureWithStack as logBootstrapFailure } from '../../lib/failureLogging.js';

export function startBackgroundSchedulers({ io, armHostedSessions }) {
  // Arm the managed-model-server idle reaper. Timer only — it reads timestamps
  // and may stop a PM2 process, and makes no AI provider call, so it is safe
  // under AGENTS.md's "No cold-bootstrap LLM calls". Off in practice until the
  // user sets an idle window (0 = never, the default).
  startIdleReaper();
  // Arm the FableLoom hosted-session sweeper. Timer only — it walks in-memory
  // QR play sessions and tears down the ones past their TTL, making no AI
  // provider call, so it is safe under AGENTS.md's "No cold-bootstrap LLM calls".
  armHostedSessions({ io });
  // Initialize activity-digest scheduler — OFF by default; drafts daily-log
  // auto-summaries from the Human Activity timeline only when the user enables it
  // (Settings → Daily Log → Activity Digest). Silent + no LLM calls until then.
  startActivityDigestScheduler();
  // Initialize twin-enrichment scheduler — LLM-free daily rollup of observed
  // taste + chronotype evidence from the Human Activity timeline (#2156). No
  // provider calls; the AI interpretation is a separate explicit-button action.
  startTwinEnrichmentScheduler();
  // Initialize brain→memory bridge (mirrors brain data into CoS memory for semantic search)
  initBrainMemoryBridge();
  // Load any on-disk POST drill cache into memory. Does NOT trigger LLM calls —
  // cache fill only happens on explicit user request (see meatspacePostRoutes.js).
  initDrillCache().catch(err => logBootstrapFailure('❌ POST drill cache init failed', err));
  // Register the optional daily POST reminder (opt-in, off by default) if the
  // user has enabled it — deterministic cron nudge, no LLM calls.
  // catchUpMissedSlot: true so a reminder whose slot elapsed while the server
  // was down (or during a redeploy) still fires once we're back up, instead of
  // silently waiting for tomorrow's tick (#2015).
  registerPostReminderSchedule({ catchUpMissedSlot: true }).catch(err => logBootstrapFailure('❌ POST reminder init failed', err));
  // Register the optional daily autobiography story prompt (opt-in, off by
  // default, and only when the instance feature is on) — deterministic prompt
  // bank, no LLM calls. Same catch-up rationale as the POST reminder above.
  registerAutobiographyReminderSchedule({ catchUpMissedSlot: true }).catch(err => logBootstrapFailure('❌ Autobiography reminder init failed', err));
  // Initialize backup scheduler for daily data backups
  startBackupScheduler().catch(err => logBootstrapFailure('❌ Backup scheduler init failed', err));
  // Automatic PortOS self-update — OFF by default. When the user turns it on
  // (Update tab), it polls for a window in which the install is completely idle
  // and then runs the SAME update the matching button runs. Registering the
  // poll launches nothing by itself.
  startAutoUpdateScheduler(io).catch(err => logBootstrapFailure('❌ Auto-update scheduler init failed', err));
  // Initialize Privacy Center opt-out recheck scheduler — OFF by default; only
  // re-runs the broker scan + opt-out pass when the user opts in via
  // Settings → Privacy (sanctioned scheduled-automation exception) (#2145).
  startPrivacyRecheckScheduler({ catchUpMissedSlot: true }).catch(err => logBootstrapFailure('❌ Privacy recheck scheduler init failed', err));
  // Quota-burn loop — ONE install-level loop that spends subscription quota that
  // would otherwise expire. OFF by default: the tick returns before touching a
  // provider unless the user enabled it on the Quota Burn page, where the
  // family, provider, model, and work are all named first (sanctioned
  // scheduled-automation exception).
  startQuotaBurnScheduler();
  // Manual maintenance runs (Schedule tab → "Run maintenance now"): arms a
  // listener and a slow sweep; dispatches only for a run the user started.
  startMaintenanceRunScheduler();
  // GitHub inbox Resolve with agent (#13191): marks a thread done when the
  // agent run the operator started on it succeeds. Starts no agent itself.
  startNotificationResolveListener();
  // Initialize Series Autopilot scheduler — OFF by default; registers a cron per
  // series only when the user configured + enabled one via Settings → Series
  // Autopilot. Each scheduled run still passes through the cos autonomy gate +
  // daily budget (sanctioned scheduled-automation exception) (#2174).
  startSeriesAutopilotScheduler().catch(err => logBootstrapFailure('❌ Series Autopilot scheduler init failed', err));
  // Autonomous Creation Engine (#2657) — arm a cron per enabled Creative
  // Commission. Boot only ARMS timers; nothing fires until a cadence elapses, and
  // each fire gates on creative autonomy `execute` + the daily cos budget (so an
  // `off`/`dry-run` install generates nothing). Sanctioned scheduled-automation.
  // The backfill is pure data movement (no LLM), idempotent, best-effort. The
  // scripts/migrations runner executes before the DB pool is up, so the data move
  // lives here (see the migration 194 registration stub); the table itself is
  // created by ensureSchema. Backfill-before-arm ordering lives in
  // bootstrapSequence.js.
  armCommissionScheduler({
    backfillCommissionFeedback: backfillAllCommissionFeedback,
    backfillProjectCommissionIds,
    startCommissionScheduler
  });
  // Executable Eidoverse world controllers (#7456) — arm the supervisor only
  // when this install has at least one ARMED controller, so a world nobody has
  // built in registers nothing and logs nothing. Boot arms a timer and nothing
  // else: a controller step is synchronous by construction, so the tick path
  // cannot reach an AI provider at all, and no install steps until its own
  // cadence elapses.
  startEidoverseControllerSupervisor().catch(err => logBootstrapFailure('❌ Eidoverse controller supervisor arming failed', err));
  // OpenWorld's historical snapshot scheduler is retired with its UI. The
  // legacy read/capture routes remain available for old clients, but Eidoverse
  // is now the only automatic world projection path.
  // Initialize iMessage sync scheduler — OFF by default; only polls chat.db when
  // the user opts in from the iMessage Settings drawer on Comms → Messages → iMessage
  // (needs macOS Full Disk Access) (#2151).
  startImessageScheduler().catch(err => logBootstrapFailure('❌ iMessage sync scheduler init failed', err));
  // Initialize Signal sync scheduler — OFF by default; only reads the SQLCipher
  // chat DB (via the keychain-wrapped key) when the user opts in via
  // Settings → Signal (#2154).
  startSignalScheduler().catch(err => logBootstrapFailure('❌ Signal sync scheduler init failed', err));
  // Initialize Spotify sync scheduler — OFF by default; only polls the
  // recently-played API when the user connects Spotify + opts in via
  // Settings → Spotify (#2152).
  startSpotifyScheduler().catch(err => logBootstrapFailure('❌ Spotify sync scheduler init failed', err));
  // Initialize YouTube watch-history sync scheduler — OFF by default; only scrapes
  // the signed-in history page in the managed browser when the user opts in via
  // Settings → YouTube (#2153).
  startYoutubeScheduler().catch(err => logBootstrapFailure('❌ YouTube sync scheduler init failed', err));
  // Initialize the Beeper ingestion sweep — OFF by default; registers only when
  // the Beeper instance feature is on AND a token is configured, and then only
  // runs when `settings.beeper.enabled` is set (fork issue #32). Deliberately
  // NOT gated on Beeper's own `app.state`, which was measured reporting
  // `initializing` for 105s while every account was connected.
  startBeeperScheduler().catch(err => logBootstrapFailure('❌ Beeper sync scheduler init failed', err));
  // Reconcile the outbox's two non-terminal states against the process that
  // just died: a row left in `sending` becomes a failed row the user can act on
  // (never an automatic resend — Beeper has no idempotency key), and a row left
  // in `awaiting-confirmation` gets its lookup re-armed, which reads and never
  // sends. Deliberately NOT on the ingestion gate above: a send stranded by a
  // restart is stranded whether or not scheduled sync is switched on, and it is
  // otherwise un-actionable forever, since nothing but this can move it.
  reconcileOutboxOnBoot().catch(err => logBootstrapFailure('❌ Beeper outbox boot reconcile failed', err));
  // Arm the Beeper realtime transport on the SAME gate as the sweep above
  // (feature on + token present, never `app.state`) — one long-lived WebSocket
  // to the local Beeper Desktop whose only job is to make ingestion prompt
  // (fork issue #33). Correctness stays with the sweep: a reconnect, a `seq`
  // gap or an `app.state` recovery each ask it to run early.
  startBeeperSocket().catch(err => logBootstrapFailure('❌ Beeper realtime transport init failed', err));
  // Periodically GC orphan zero-issue/zero-canon importer shells left by an
  // abandoned analyze (issue #727).
  startOrphanShellGc();
  // Periodically GC orphan staged init/reference upload images that pile up in
  // data/image-refs on every i2i/edit render and are never cleaned up (issue #1214).
  startImageRefsGc();
  // Periodically GC the Image Cleaner's GPU-clean temp working files (init/render/
  // mask/original) that land in data/image-clean-tmp and are never long-lived
  // (issue #2264). Age-gate only — nothing here is referenced after the fetch.
  startImageCleanTmpGc();
  // Periodically GC leftover `${dest}.partial` files from resumable weight
  // downloads (issue #5855). Age-gated (7 days) so an overnight pause-and-resume
  // is not punished; in-flight spec-decode dests are also pinned. Fire-and-forget
  // like the other GCs — not part of the awaited warmStores pruneLegacyFiles
  // chain, so a large sweep cannot stall listen().
  startOrphanedPartialGc();
  // Periodically bound the Beeper attachment mirror: evict least-recently-viewed
  // bytes down to `settings.beeper.attachmentBudgetGb` (never evicting a file
  // Beeper can no longer re-supply, and never one the user locked with `keep`),
  // and heal the store both ways — orphan files no row points at, rows whose
  // file is gone, abandoned partials (fork issue #37). Housekeeping over local
  // bytes, so it is NOT gated on the ingestion toggle: turning scheduled sync
  // off does not make an over-budget mirror stop being over budget.
  startBeeperAttachmentGc();
  // Erase Tribe people deleted more than 30 days ago — with their touchpoints,
  // identities, memory links and audit snapshots — and expire older tribe audit
  // snapshots (#8459). Deleting a contact must eventually erase a third party's data.
  startTribePurge();
  // Periodically expire images handed to agents via data/screenshots: shell
  // image drops after 7 days, other screenshots after 30 unless a live CoS task
  // still references them (issue #8461). Fails closed on an unreadable task store.
  startScreenshotsGc();
}
