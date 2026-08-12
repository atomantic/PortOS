/**
 * Series Autopilot — arc generation/repair/episode steps (#2842 split of
 * seriesAutopilot.js): the macro-arc generation step, the duplicate-volume
 * repair preflight, and the per-volume episode generation step.
 */

import { recordDomainUsage } from '../../domainUsage.js';
import { getSeries } from '../series.js';
import {
  generateArcOverview, commitSeasonsWithRemap, generateSeasonEpisodes, commitEpisodesToIssues,
  ERR_VALIDATION, hasDuplicateSeasonNumbers,
} from '../arcPlanner.js';
import { providerOverrideOpts, seasonPreserveOpts } from './session.js';

export async function runGenerateArc(sId, record) {
  // Mark attempted up front so the resolver won't re-route here if arc
  // generation yields no seasons (avoids an infinite generateArc loop).
  record.runState.arcAttempted = true;
  const r = await generateArcOverview(sId, providerOverrideOpts(record));
  const committed = await commitSeasonsWithRemap(
    await getSeries(sId),
    { arc: r.arc, seasons: r.seasons },
    seasonPreserveOpts(record),
  );
  await recordDomainUsage('cos', { actions: 1 });
  const seasonCount = committed?.series?.seasons?.length ?? (await getSeries(sId)).seasons?.length ?? 0;
  if (seasonCount === 0) {
    // No specific gap filed here — let the conductor file generateArc-stalled.
    return {
      pause: true,
      reason: 'arc generation produced no volumes — cannot create issues; review the series bible and regenerate the arc',
      residual: [{ severity: 'high', location: 'arc', problem: 'arc overview returned zero seasons/volumes' }],
    };
  }
  return {};
}

export async function runRepairArcStructure(sId, record) {
  const current = await getSeries(sId);
  // commitSeasonsWithRemap owns the safe duplicate-collapse + child remap,
  // but correctly refuses every arc write while the arc freeze is set. Pause
  // here with an actionable reason rather than turning a deterministic
  // preflight into a generic run error (or, worse, seeding duplicate volumes).
  if (current.locked?.arc === true) {
    return {
      pause: true,
      pauseKind: 'inapplicable',
      reason: 'Duplicate volume records must be normalized before issue generation, but the arc is locked. Resume with full edit control enabled.',
      residual: [{ severity: 'high', location: 'series volumes', problem: 'duplicate volume numbers are blocked from repair by the arc lock' }],
    };
  }
  const committed = await commitSeasonsWithRemap(
    current,
    { arc: current.arc, seasons: current.seasons },
    seasonPreserveOpts(record),
  );
  const repaired = committed?.series ?? await getSeries(sId);
  // Two user-locked duplicates are deliberately not collapsed by the shared
  // helper. Stop before generation and ask for the same explicit full-control
  // consent that clears those locks; never fill malformed records with work.
  if (hasDuplicateSeasonNumbers(repaired.seasons)) {
    return {
      pause: true,
      pauseKind: 'inapplicable',
      reason: 'Duplicate volume records are still locked and could not be normalized. Resume with full edit control enabled.',
      residual: [{ severity: 'high', location: 'series volumes', problem: 'multiple locked records share a volume number' }],
    };
  }
  return {};
}

export async function runGenerateEpisodes(sId, step, record) {
  // Mark attempted up front so an empty/invalid episode list can't re-loop
  // the resolver back into generateEpisodes for the same still-empty volume.
  record.runState.episodesAttempted.add(step.seasonId);
  const r = await generateSeasonEpisodes(sId, step.seasonId, providerOverrideOpts(record));
  const cur = await getSeries(sId);
  const commitResult = await commitEpisodesToIssues(sId, step.seasonId, r.episodes, {
    preloadedSeries: cur,
    reuseUngrouped: true,
  }).then((created) => ({ created, error: null })).catch((error) => ({ created: null, error }));
  if (commitResult.error) {
    if (commitResult.error.code !== ERR_VALIDATION) throw commitResult.error;
    return {
      pause: true,
      pauseKind: 'inapplicable',
      reason: commitResult.error.message,
      residual: [{ severity: 'high', location: 'issue placeholders', problem: commitResult.error.message }],
    };
  }
  const created = commitResult.created;
  await recordDomainUsage('cos', { actions: 1 });
  if (!Array.isArray(created) || created.length === 0) {
    return {
      pause: true,
      reason: `episode generation produced no issues for volume ${step.seasonId} — review the volume outline and regenerate`,
      residual: [{ severity: 'high', location: `volume ${step.seasonId}`, problem: 'episode breakdown returned zero episodes/issues' }],
    };
  }
  return {};
}
