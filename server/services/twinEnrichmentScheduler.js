/**
 * Twin Enrichment Scheduler (Human Activity Tracking Phase 7, #2156).
 *
 * Backstop daily rollup for the observed taste + chronotype evidence. The
 * evidence is normally kept fresh incrementally by each media sync (Spotify /
 * YouTube call `refreshTwinEvidenceAfterSync()` after recording events), but a
 * machine whose media sources are idle can still accumulate message/calendar
 * activity that shifts the chronotype histogram — so we recompute once per local
 * day regardless.
 *
 * ZERO provider calls — aggregation is deterministic and LLM-free, so this runs
 * unattended with no user consent (the AI-provider policy only gates the
 * explicit "interpret" button, which lives on the Digital Twin UI). The issue's
 * design explicitly sanctions running the rollup with no consent "since no
 * provider calls," so an initial recompute at boot is fine; thereafter it
 * recomputes once per local calendar day.
 */

import { todayInTimezone, getUserTimezone } from '../lib/timezone.js';
import { aggregateTwinEvidence } from './twinEnrichment.js';

let schedulerInterval = null;
let running = false;
// Local calendar day (YYYY-MM-DD) we last recomputed for. Module-level: a
// restart re-runs at most once (cheap, idempotent) — not worth a state file.
let lastRunDate = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — a daily rollup needs no finer cadence

async function checkSchedule() {
  if (running) return;
  const timezone = await getUserTimezone();
  const today = todayInTimezone(timezone);
  if (today === lastRunDate) return; // already rolled up for this local day

  running = true;
  try {
    await aggregateTwinEvidence();
    lastRunDate = today;
  } finally {
    running = false;
  }
}

export function startTwinEnrichmentScheduler() {
  if (schedulerInterval) {
    console.log('🧭 Twin enrichment scheduler: already running');
    return;
  }
  console.log('🧭 Twin enrichment scheduler: starting');
  // Wrapped so an early throw (e.g. DB not ready at boot) can't crash the
  // process — this runs outside the request lifecycle.
  checkSchedule().catch((err) => console.error(`🧭 Twin enrichment initial rollup failed: ${err.message}`));
  schedulerInterval = setInterval(() => {
    checkSchedule().catch((err) => console.error(`🧭 Twin enrichment rollup check failed: ${err.message}`));
  }, CHECK_INTERVAL_MS);
}

export function stopTwinEnrichmentScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🧭 Twin enrichment scheduler: stopped');
  }
}
