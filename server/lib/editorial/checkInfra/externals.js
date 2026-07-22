/**
 * Editorial check infra — external primitives hub (#2842 split of checkInfra.js).
 *
 * The single place `./checks/*.js` and `checkRegistry.js` reach for the pure
 * scanners in the sibling editorial libs plus `zod`/`estimateTokens`. Kept as
 * one hub so a check file imports everything from `checkInfra.js` (the barrel)
 * without fanning out to a dozen deep imports.
 */

import { z } from 'zod';
import { estimateTokens } from '../../contextBudget.js';
import { renderCharacterArcsForPrompt } from '../../seriesCharacterArc.js';
import { parseComicScript } from '../../comicScriptParser.js';
import {
  analyzeComicLettering,
  DEFAULT_LETTERING_THRESHOLDS,
} from '../letteringDensity.js';
import { analyzeBalloonAttribution } from '../balloonAttribution.js';
import { analyzeNamePair, comparisonName, findFirstLetterClusters, normalizeName } from '../nameSimilarity.js';
import { findCliches, findModifierStacking } from '../cliches.js';
import { findSaidBookisms, findUnattributedDialogueRuns, attributeDialogueByOwner, findDialogueTagVariety, splitScenes } from '../dialogue.js';
import { findItalicThoughts } from '../italicThoughts.js';
import {
  findFilterWords,
  findHedgeWords,
  findCrutchWords,
  findAdverbs,
  findPassiveVoice,
  filterPassiveVoice,
  findGestures,
} from '../proseTics.js';
import {
  findWordEchoes,
  findRepeatedOpeners,
  measureSentenceRhythm,
} from '../repetition.js';
import {
  findBannedWordsTier1,
  findSuspiciousWordClusters,
  findAiTells,
  findNotJustButPatterns,
  findNotSayingPatterns,
  findNegativeAssertions,
  findTheWaySimiles,
  findTriadicShortSentences,
  findStructuralTics,
  emDashDensityPer1000,
  transitionOpenerRatio,
  paragraphLengthUniformity,
  countSectionBreaks,
  MIN_DENSITY_OCCURRENCES,
} from '../slopScore.js';
import {
  analyzePanelRhythm,
  comicPageTurnSummary,
  authoredRevealSummary,
} from '../comicPacing.js';
import { findAxisReversals, findShotTypeMonotony, summarizeStoryboardShots } from '../shotContinuity.js';
import { revealGatedCanonRows, canonHasRevealGated } from '../../storyBible.js';

// Re-exported so ./checks/*.js and ./checkRegistry.js import everything from here.
export {
  DEFAULT_LETTERING_THRESHOLDS,
  MIN_DENSITY_OCCURRENCES,
  analyzeBalloonAttribution,
  analyzeComicLettering,
  analyzeNamePair,
  analyzePanelRhythm,
  attributeDialogueByOwner,
  authoredRevealSummary,
  comicPageTurnSummary,
  comparisonName,
  countSectionBreaks,
  emDashDensityPer1000,
  estimateTokens,
  filterPassiveVoice,
  findAdverbs,
  findAiTells,
  findAxisReversals,
  findBannedWordsTier1,
  findCliches,
  findCrutchWords,
  findDialogueTagVariety,
  findFilterWords,
  findFirstLetterClusters,
  findGestures,
  findHedgeWords,
  findItalicThoughts,
  findModifierStacking,
  findNegativeAssertions,
  findNotJustButPatterns,
  findNotSayingPatterns,
  findPassiveVoice,
  findRepeatedOpeners,
  findSaidBookisms,
  findShotTypeMonotony,
  findStructuralTics,
  findSuspiciousWordClusters,
  findTheWaySimiles,
  findTriadicShortSentences,
  findUnattributedDialogueRuns,
  findWordEchoes,
  measureSentenceRhythm,
  normalizeName,
  paragraphLengthUniformity,
  parseComicScript,
  renderCharacterArcsForPrompt,
  splitScenes,
  summarizeStoryboardShots,
  transitionOpenerRatio,
  canonHasRevealGated,
  revealGatedCanonRows,
  z,
};

