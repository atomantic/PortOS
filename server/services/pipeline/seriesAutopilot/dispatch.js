/**
 * Series Autopilot — step dispatch table (#2842 split of seriesAutopilot.js).
 * Maps a resolved step kind onto the runner that executes it.
 */

import { recordDomainUsage } from '../../domainUsage.js';
import { getSeries } from '../series.js';
import { generateArcOverview, commitSeasonsWithRemap, generateSeasonEpisodes, commitEpisodesToIssues } from '../arcPlanner.js';
import { providerOverrideOpts } from './session.js';
import { runArcVerify, runBeats, runBeatContinuity, runFoundationGate, runText } from './childRuns.js';
import { runScriptVerify, runEditorial, runReverseOutlineRefresh, runEditorialChecksPass, runEditorialHealthGate } from './editorialSteps.js';
import { runCanonVerify, runVisualDraft, runProduceTeaser } from './visualSteps.js';
import { runRevisionCycle } from './revisionSteps.js';

export async function dispatchStep(sId, step, record) {
  switch (step.kind) {
    case 'generateArc': {
      // Mark attempted up front so the resolver won't re-route here if arc
      // generation yields no seasons (avoids an infinite generateArc loop).
      record.runState.arcAttempted = true;
      const r = await generateArcOverview(sId, providerOverrideOpts(record));
      const committed = await commitSeasonsWithRemap(await getSeries(sId), { arc: r.arc, seasons: r.seasons });
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
    case 'generateEpisodes': {
      // Mark attempted up front so an empty/invalid episode list can't re-loop
      // the resolver back into generateEpisodes for the same still-empty volume.
      record.runState.episodesAttempted.add(step.seasonId);
      const r = await generateSeasonEpisodes(sId, step.seasonId, providerOverrideOpts(record));
      const cur = await getSeries(sId);
      const created = await commitEpisodesToIssues(sId, step.seasonId, r.episodes, { preloadedSeries: cur });
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
    case 'verifyArc':
      return runArcVerify(sId, record);
    case 'beatSheet':
      return runBeats(sId, step.seasonId, record);
    case 'beatContinuity':
      return runBeatContinuity(sId, record);
    case 'foundationGate':
      return runFoundationGate(sId, record);
    case 'textStages':
      return runText(sId, step.issueId, record);
    case 'scriptVerify':
      return runScriptVerify(sId, step.issueId, record);
    case 'editorialReview':
      return runEditorial(sId, record);
    case 'reverseOutline':
      return runReverseOutlineRefresh(sId, record);
    case 'editorialChecks':
      return runEditorialChecksPass(sId, record);
    case 'editorialHealthGate':
      return runEditorialHealthGate(sId, record);
    case 'revisionCycle':
      return runRevisionCycle(sId, record);
    case 'canonVerify':
      return runCanonVerify(sId, record);
    case 'visualDraft':
      return runVisualDraft(sId, step.issueId, record);
    case 'produceTeaser':
      return runProduceTeaser(sId, step.issueId, record);
    default:
      return {};
  }
}
