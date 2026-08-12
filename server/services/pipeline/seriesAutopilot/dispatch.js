/**
 * Series Autopilot — step dispatch table (#2842 split of seriesAutopilot.js).
 * Maps a resolved step kind onto the runner that executes it.
 */

import { runArcVerify, runBeats, runBeatContinuity, runCharacterFoundation, runFoundationGate, runText } from './childRuns.js';
import { runScriptVerify, runEditorial, runReverseOutlineRefresh, runEditorialChecksPass, runEditorialHealthGate } from './editorialSteps.js';
import { runCanonVerify, runVisualDraft, runProduceTeaser } from './visualSteps.js';
import { runRevisionCycle } from './revisionSteps.js';
import { runUnlockPass } from './unlockPass.js';
import { runGenerateArc, runRepairArcStructure, runGenerateEpisodes } from './arcSteps.js';

export async function dispatchStep(sId, step, record) {
  switch (step.kind) {
    case 'unlockLocks':
      return runUnlockPass(sId, record);
    case 'characterFoundation':
      return runCharacterFoundation(sId, record);
    case 'generateArc':
      return runGenerateArc(sId, record);
    case 'repairArcStructure':
      return runRepairArcStructure(sId, record);
    case 'generateEpisodes':
      return runGenerateEpisodes(sId, step, record);
    case 'verifyArcSpine':
      return runArcVerify(sId, record, { spineOnly: true });
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
