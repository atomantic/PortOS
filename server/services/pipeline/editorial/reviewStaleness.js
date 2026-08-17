/**
 * Pipeline editorial review staleness.
 *
 * Owns the source projections and deterministic fingerprints shared by the
 * editorial-check seed path and the read-time review annotation path. Keeping
 * both consumers on this boundary prevents their source contracts from
 * drifting while leaving checkRunner focused on conducting checks.
 */

import { createHash } from 'crypto';
import {
  EDITORIAL_SOURCES,
  comicLetteringIssues,
  getAllChecks,
  proseStageIssues,
} from '../../../lib/editorial/index.js';
import { canonicalStringify } from '../../../lib/objects.js';
import { getSettings } from '../../settings.js';
import {
  buildCompletenessContext,
  collectManuscriptSections,
  completenessSourceHash,
  sectionsCorpus,
} from '../arcPlanner.js';
import { getFactsLedger } from '../continuityBible.js';
import { getSeriesEditorial } from '../editorialAnalysis.js';
import { listIssuesForSeries } from '../issues.js';
import { getReview } from '../manuscriptReview.js';
import { getReverseOutline } from '../reverseOutline.js';
import { getSeries } from '../series.js';
import { getSeriesCanon } from '../seriesCanon.js';

// Source-content fingerprinting for finding staleness (#1345, #1387). Each
// finding is stamped with a hash of the exact content its check analyzed; the
// manuscript editor / triage view flags a finding `stale` once that content
// drifts.
//
// Per-check declared sources (#1387): a check declares the inputs its run()
// reads via `check.sources` (a subset of EDITORIAL_SOURCES), and we fingerprint
// EXACTLY those. `canonicalStringify` keeps hashes stable across machines. The
// load-time guard below ensures a newly declared source cannot silently hash as
// empty.
const HASH_SEP = '\u0000';
const sha256 = (text) => createHash('sha256').update(text || '').digest('hex');
const SOURCE_RESOLVERS = {
  manuscript: ({ manuscript }) => manuscript || '',
  canon: ({ canon }) => canonicalStringify(canon ?? null),
  continuityBible: ({ continuityBible }) => canonicalStringify(continuityBible ?? null),
  'series.styleGuide': ({ series }) => canonicalStringify(series?.styleGuide ?? null),
  'series.arc.tickingClock': ({ series }) => canonicalStringify(series?.arc?.tickingClock ?? null),
  'series.arc.readerMap': ({ series }) => canonicalStringify(series?.arc?.readerMap ?? null),
  'series.arc.foreshadowing': ({ series }) => canonicalStringify(series?.arc?.foreshadowing ?? null),
  'series.arc.themes': ({ series }) => canonicalStringify(series?.arc?.themes ?? null),
  'series.factReference': ({ series }) => canonicalStringify(series?.factReference ?? null),
  reverseOutline: ({ reverseOutline }) => canonicalStringify(reverseOutline ?? null),
  'reverseOutline.plotlines': ({ reverseOutlinePlotlines }) =>
    canonicalStringify(reverseOutlinePlotlines ?? null),
  editorialArcs: ({ editorialArcs, editorialArcsComplete }) =>
    canonicalStringify({ arcs: editorialArcs ?? null, complete: editorialArcsComplete === true }),
  'series.characterArcs': ({ series }) => canonicalStringify(series?.characterArcs ?? null),
  'storyboard.shots': ({ storyboardScenes }) =>
    canonicalStringify(projectStoryboardContinuity(storyboardScenes) ?? null),
  comicScript: ({ comicScripts }) => canonicalStringify(comicScripts ?? null),
  'comicScript.pacing': ({ comicPacingContent }) => canonicalStringify(comicPacingContent ?? null),
  'comicScript.layout': ({ comicLayoutContent }) => canonicalStringify(comicLayoutContent ?? null),
  prose: ({ proseContent }) => canonicalStringify(proseContent ?? null),
};

function collectStoryboardScenes(issues) {
  const out = [];
  for (const issue of (Array.isArray(issues) ? issues : [])) {
    const scenes = issue?.stages?.storyboards?.scenes;
    if (!Array.isArray(scenes) || !scenes.length) continue;
    const issueNumber = Number.isInteger(issue.number) ? issue.number : null;
    for (const scene of scenes) {
      if (scene && typeof scene === 'object') out.push({ issueNumber, scene });
    }
  }
  return out;
}

function projectStoryboardContinuity(storyboardScenes) {
  return (Array.isArray(storyboardScenes) ? storyboardScenes : []).map(({ issueNumber, scene }) => ({
    issueNumber: Number.isInteger(issueNumber) ? issueNumber : null,
    heading: typeof scene?.heading === 'string' ? scene.heading : '',
    slugline: typeof scene?.slugline === 'string' ? scene.slugline : '',
    shots: (Array.isArray(scene?.shots) ? scene.shots : []).map((shot) => ({
      id: typeof shot?.id === 'string' ? shot.id : '',
      continuityFromShotId: typeof shot?.continuityFromShotId === 'string' ? shot.continuityFromShotId : null,
      screenDirection: typeof shot?.screenDirection === 'string' ? shot.screenDirection : null,
      shotType: typeof shot?.shotType === 'string' ? shot.shotType : null,
      description: typeof shot?.description === 'string' ? shot.description : '',
    })),
  }));
}

function projectComicLetteringContent(comicIssues) {
  return comicIssues.map(({ number, pages }) => ({
    number,
    pages: pages.map((page) => ({
      panels: (Array.isArray(page?.panels) ? page.panels : []).map((panel) => ({
        caption: typeof panel?.caption === 'string' ? panel.caption : '',
        dialogue: Array.isArray(panel?.dialogue) ? panel.dialogue : [],
        sfx: typeof panel?.sfx === 'string' ? panel.sfx : '',
      })),
    })),
  }));
}

function projectComicPacingContent(comicIssues) {
  return comicIssues.map(({ number, pages }) => ({
    number,
    pages: pages.map((page) => ({
      panels: (Array.isArray(page?.panels) ? page.panels : []).map((panel) => ({
        description: typeof panel?.description === 'string' ? panel.description : '',
        caption: typeof panel?.caption === 'string' ? panel.caption : '',
        dialogue: Array.isArray(panel?.dialogue) ? panel.dialogue : [],
        sfx: typeof panel?.sfx === 'string' ? panel.sfx : '',
      })),
    })),
  }));
}

function projectComicLayoutContent(comicIssues) {
  return comicIssues.map(({ number, pages }) => ({
    number,
    panelCounts: pages.map((page) => (Array.isArray(page?.panels) ? page.panels.length : 0)),
  }));
}

function projectEditorialArcs(editorial) {
  const chars = Array.isArray(editorial?.characters) ? editorial.characters : [];
  return chars.map((character) => ({
    name: character?.name || '',
    arcDirection: character?.arcDirection || 'flat',
    issueCount: Number.isFinite(character?.issueCount) ? character.issueCount : 0,
    isProtagonist: character?.isProtagonist === true,
  }));
}

function editorialCoverageComplete(editorial) {
  const coverage = editorial?.coverage;
  return !!coverage
    && coverage.withContent > 0
    && coverage.analyzed >= coverage.withContent
    && (coverage.stale || 0) === 0;
}

for (const token of EDITORIAL_SOURCES) {
  if (typeof SOURCE_RESOLVERS[token] !== 'function') {
    throw new Error(`checkRunner: editorial source "${token}" has no fingerprint resolver — keep SOURCE_RESOLVERS in sync with EDITORIAL_SOURCES`);
  }
}

export function checkSources(check) {
  const declared = Array.isArray(check?.sources) && check.sources.length
    ? check.sources
    : (check?.needsManuscript ? ['manuscript', 'canon'] : ['canon']);
  return declared.filter((token) => SOURCE_RESOLVERS[token]);
}

export function effectiveCheckSources(check, checkById) {
  const own = checkSources(check);
  const deps = Array.isArray(check?.dependsOn) ? check.dependsOn : [];
  if (!deps.length || !(checkById instanceof Map)) return own;
  const tokens = new Set(own);
  const seen = new Set([check?.id]);
  const stack = [...deps];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = checkById.get(id);
    if (!dep) continue;
    for (const token of checkSources(dep)) tokens.add(token);
    for (const next of (Array.isArray(dep.dependsOn) ? dep.dependsOn : [])) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return [...tokens];
}

function resolveSources(inputs) {
  const resolved = {};
  for (const token of EDITORIAL_SOURCES) resolved[token] = SOURCE_RESOLVERS[token](inputs);
  return resolved;
}

export function fingerprintForCheck(check, resolved, checkById = null) {
  const segments = [...new Set(effectiveCheckSources(check, checkById))]
    .sort()
    .map((token) => `${token}=${resolved[token]}`);
  if (check?.isCustom && typeof check.prompt === 'string') {
    segments.push(`definition=${check.prompt}`);
  }
  return sha256(segments.join(HASH_SEP));
}

/**
 * Project the raw editorial data sources once for both the check-run context and
 * read-time fingerprinting. The returned context fields are the exact values
 * checks consume; `resolvedSources` is their stable token-to-string projection.
 */
export function buildEditorialSourceProjection({
  manuscript,
  canon,
  series,
  issues,
  outline,
  editorial,
  bible,
}) {
  const continuityBible = Array.isArray(bible?.facts) ? bible.facts : [];
  const storyboardScenes = collectStoryboardScenes(issues);
  const reverseOutline = Array.isArray(outline?.scenes) ? outline.scenes : [];
  const reverseOutlinePlotlines = Array.isArray(outline?.plotlines) ? outline.plotlines : [];
  const editorialArcs = projectEditorialArcs(editorial);
  const editorialArcsComplete = editorialCoverageComplete(editorial);
  const comicIssues = comicLetteringIssues(issues);
  const comicScripts = projectComicLetteringContent(comicIssues);
  const comicPacingContent = projectComicPacingContent(comicIssues);
  const comicLayoutContent = projectComicLayoutContent(comicIssues);
  const proseContent = proseStageIssues(issues);
  const resolvedSources = resolveSources({
    manuscript,
    canon,
    continuityBible,
    series,
    reverseOutline,
    reverseOutlinePlotlines,
    editorialArcs,
    editorialArcsComplete,
    storyboardScenes,
    comicScripts,
    comicPacingContent,
    comicLayoutContent,
    proseContent,
  });
  return {
    continuityBible,
    storyboardScenes,
    reverseOutline,
    reverseOutlinePlotlines,
    editorialArcs,
    editorialArcsComplete,
    resolvedSources,
  };
}

/**
 * Read the manuscript review and derive `stale` against the exact content each
 * editorial check or completeness pass analyzed. The annotation is never
 * persisted and therefore never rides the synced review document.
 */
export async function getReviewWithStaleness(seriesId) {
  const review = await getReview(seriesId);
  const settings = await getSettings();
  const byId = new Map(getAllChecks(settings).map((check) => [check.id, check]));
  const checkFor = (id) => byId.get(id) || null;
  const evaluable = review.comments.filter((comment) =>
    comment.checkId && comment.sourceContentHash && checkFor(comment.checkId));
  const completeness = review.comments.filter((comment) =>
    !comment.checkId && comment.sourceContentHash);
  if (!evaluable.length && !completeness.length) return review;

  if (!evaluable.length) {
    const [series, sections] = await Promise.all([
      getSeries(seriesId),
      collectManuscriptSections(seriesId),
    ]);
    const context = await buildCompletenessContext(series, sectionsCorpus(sections));
    const current = completenessSourceHash(context);
    return {
      ...review,
      comments: review.comments.map((comment) => (!comment.checkId && comment.sourceContentHash
        ? { ...comment, stale: comment.sourceContentHash !== current }
        : comment)),
    };
  }

  const sourcesFor = (id) => effectiveCheckSources(checkFor(id), byId);
  const needsManuscript = completeness.length > 0
    || evaluable.some((comment) => sourcesFor(comment.checkId).includes('manuscript'));
  const needsReverseOutline = evaluable.some((comment) => {
    const sources = sourcesFor(comment.checkId);
    return sources.includes('reverseOutline') || sources.includes('reverseOutline.plotlines');
  });
  const needsEditorialArcs = evaluable.some((comment) =>
    sourcesFor(comment.checkId).includes('editorialArcs'));
  const needsContinuityBible = evaluable.some((comment) =>
    sourcesFor(comment.checkId).includes('continuityBible'));
  const needsStoryboards = evaluable.some((comment) =>
    sourcesFor(comment.checkId).includes('storyboard.shots'));
  const needsComicScript = evaluable.some((comment) => {
    const sources = sourcesFor(comment.checkId);
    return sources.includes('comicScript')
      || sources.includes('comicScript.pacing')
      || sources.includes('comicScript.layout');
  });
  const needsProse = evaluable.some((comment) => sourcesFor(comment.checkId).includes('prose'));
  const needsIssues = needsStoryboards || needsComicScript || needsProse;
  const series = await getSeries(seriesId);
  const [sections, canon, outline, editorial, issues, bible] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
    needsReverseOutline ? getReverseOutline(seriesId).catch(() => null) : Promise.resolve(null),
    needsEditorialArcs ? getSeriesEditorial(seriesId, { series }).catch(() => null) : Promise.resolve(null),
    needsIssues ? listIssuesForSeries(seriesId).catch(() => []) : Promise.resolve([]),
    needsContinuityBible ? getFactsLedger(seriesId).catch(() => null) : Promise.resolve(null),
  ]);
  const { resolvedSources } = buildEditorialSourceProjection({
    manuscript: sectionsCorpus(sections),
    canon,
    series,
    issues,
    outline,
    editorial,
    bible,
  });
  const currentCompletenessHash = completeness.length > 0
    ? completenessSourceHash(await buildCompletenessContext(series, resolvedSources.manuscript))
    : null;
  return {
    ...review,
    comments: review.comments.map((comment) => {
      if (!comment.checkId && comment.sourceContentHash) {
        return { ...comment, stale: comment.sourceContentHash !== currentCompletenessHash };
      }
      const check = comment.checkId && comment.sourceContentHash
        ? checkFor(comment.checkId)
        : null;
      if (!check) return comment;
      const current = fingerprintForCheck(check, resolvedSources, byId);
      return { ...comment, stale: comment.sourceContentHash !== current };
    }),
  };
}
