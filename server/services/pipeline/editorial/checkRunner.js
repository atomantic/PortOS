/**
 * Pipeline — Editorial Check Runner (#1284).
 *
 * Loads the enabled editorial checks (+ per-check config) from settings, builds
 * the shared `ctx` once (series, issues, universe canon, stitched manuscript),
 * runs each check, and seeds the resulting findings into the existing
 * `manuscriptReview` store — each finding stamped with its `checkId` so the
 * editor groups/filters by check and a dismissal stays suppressed per-check.
 *
 * Deterministic checks run inline; LLM checks reuse the staged-LLM provider
 * plumbing via the `ctx.callStagedLLM` injected here (the registry stays pure).
 *
 * The SSE wrapper at the bottom mirrors manuscriptCompletenessRunner.js: a
 * single in-memory `runs` map keyed by seriesId, terminal-frame replay for
 * late-connecting clients via lib/sseUtils.js.
 */

import { randomUUID, createHash } from 'crypto';
import { createSseRunner } from '../../../lib/sseUtils.js';
import { runStagedLLM, runInlineLLM, runStageScopedInlineLLM, resolveStageContext } from '../../../lib/stageRunner.js';
import { planManuscriptPass, fitContextToManuscriptFloor, estimateTokens, MANUSCRIPT_FLOOR_TOKENS } from '../../../lib/contextBudget.js';
import { getEnabledChecks, getEnabledCheckRows, getAllChecks, EDITORIAL_SOURCES, comicLetteringIssues } from '../../../lib/editorial/index.js';
import { getSettings } from '../../settings.js';
import { getSeries } from '../series.js';
import { listIssuesForSeries } from '../issues.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus, manuscriptSectionHeader } from '../arcPlanner.js';
import { getReverseOutline } from '../reverseOutline.js';
import { getSeriesEditorial } from '../editorialAnalysis.js';
import { seedReviewFromFindings, getReview } from '../manuscriptReview.js';
import { recordTrendSnapshot } from '../editorialScore.js';
import { readReadinessGate } from '../../../lib/editorial/index.js';
import { canonicalStringify } from '../../../lib/objects.js';

// Source-content fingerprinting for finding staleness (#1345, #1387). Each finding
// is stamped with a hash of the exact content its check analyzed; the manuscript
// editor / triage view flags a finding `stale` once that content drifts.
//
// Per-check declared sources (#1387): a check declares the inputs its run() reads
// via `check.sources` (a subset of EDITORIAL_SOURCES), and we fingerprint EXACTLY
// those — so a naming finding (sources: ['canon']) doesn't go stale on a prose or
// style-guide edit, and editing the ticking clock stales only the
// arc.ticking-clock-hygiene finding (sources: ['series.arc.tickingClock']) instead
// of every canon-only finding. This replaces the prior two-segment heuristic
// (manuscript-vs-canon) that over-flagged because it folded the style guide +
// ticking clock into shared segments.
//
// `SOURCE_RESOLVERS` maps each declared token to the exact content hashed.
// `canonicalStringify` (key-sorted) keeps the hash stable across machines so a
// synced finding isn't falsely flagged stale after an import re-orders keys. A
// load-time guard asserts every EDITORIAL_SOURCES token has a resolver here — a
// token with no resolver would silently contribute nothing (false-fresh).
const HASH_SEP = '\u0000';
const sha256 = (text) => createHash('sha256').update(text || '').digest('hex');
const SOURCE_RESOLVERS = {
  manuscript: ({ manuscript }) => manuscript || '',
  canon: ({ canon }) => canonicalStringify(canon ?? null),
  'series.styleGuide': ({ series }) => canonicalStringify(series?.styleGuide ?? null),
  'series.arc.tickingClock': ({ series }) => canonicalStringify(series?.arc?.tickingClock ?? null),
  // The authored reader-map hooks/payoffs the Chekhov check reconciles against (#1299).
  'series.arc.readerMap': ({ series }) => canonicalStringify(series?.arc?.readerMap ?? null),
  // The authored arc themes the theme.coherence check reconciles the prose against
  // (#1317). Lives on the already-loaded series record, so no extra I/O — fingerprint
  // the whole themes array so adding/editing a declared theme stales the findings.
  'series.arc.themes': ({ series }) => canonicalStringify(series?.arc?.themes ?? null),
  // The reverse-outline scenes the check reads (#1296). Fingerprinting the whole
  // scenes array is intentionally over-eager (any scene edit stales a finding)
  // rather than under: safe vs. false-fresh, and the check reads several scene fields.
  reverseOutline: ({ reverseOutline }) => canonicalStringify(reverseOutline ?? null),
  // The reverse-outline PLOTLINES the plot-structure check reconciles dropped
  // subplots against (#1310). Separate token from `reverseOutline` so a scene
  // edit that doesn't touch the plotline list doesn't needlessly stale a
  // plotline-only finding (and vice-versa) — same over-eager-but-safe policy.
  'reverseOutline.plotlines': ({ reverseOutlinePlotlines }) =>
    canonicalStringify(reverseOutlinePlotlines ?? null),
  // The detected per-character arc directions a POV check reads (#1295). The
  // injected `editorialArcs` is the stable projection (name/arcDirection/issueCount/
  // isProtagonist) — NOT the raw getSeriesEditorial output, which carries a
  // per-call `generatedAt` timestamp that would re-stale every finding each run.
  // The `complete` flag is folded in too: a prose edit that stales the analysis
  // (without re-running it) leaves the projection byte-identical but flips
  // completeness, and pov.justified's "absent from arcs" finding depends on that
  // flag — so a finding must go stale when it changes, not only when the arcs do.
  editorialArcs: ({ editorialArcs, editorialArcsComplete }) =>
    canonicalStringify({ arcs: editorialArcs ?? null, complete: editorialArcsComplete === true }),
  // The AUTHORED per-character story arcs the arc.transitions check reconciles
  // against (#1293). Lives on the already-loaded series record, so no extra I/O
  // — fingerprint the whole array so any arc/transition edit stales the findings.
  'series.characterArcs': ({ series }) => canonicalStringify(series?.characterArcs ?? null),
  // The per-issue storyboard shot lists the visual.shot-continuity check reads
  // (#1315). Fingerprint ONLY the fields the check actually reads (scene
  // heading/slugline + each shot's grammar fields) via `projectStoryboardContinuity`
  // — NOT the whole scene object, so an unrelated render/status edit
  // (`imageJobId`, `sceneVideoJobId`, wardrobe metadata) doesn't falsely stale a
  // continuity finding. Mirrors `projectComicLetteringContent` for the comic check.
  'storyboard.shots': ({ storyboardScenes }) =>
    canonicalStringify(projectStoryboardContinuity(storyboardScenes) ?? null),
  // Every issue's AUTHORITATIVE comic lettering content, keyed by issue number
  // (#1313). The lettering-density check reads the edited comic-pages split (or the
  // generated script when unsplit) — NOT the prose manuscript — so it gets its own
  // source token: editing a comic script/page stales lettering findings without
  // staling prose findings, and vice-versa. `projectComicLetteringContent` builds
  // the stable [{ number, panels: [{ caption, dialogue, sfx }] }] off the SAME
  // `comicLetteringIssues` the check analyzes, so a finding stales exactly when the
  // text it read changes (and an unrelated image render — `panel.imageJobId` — does
  // NOT stale it, since only the lettering fields are projected).
  comicScript: ({ comicScripts }) => canonicalStringify(comicScripts ?? null),
  // The page-turn check's content (#1314) — its own token because it reads each
  // panel's visual `description` (+ caption/dialogue/SFX text) for the LLM digest.
  // A description edit stales a page-turn finding without staling a lettering one
  // (which doesn't read `description`), and vice-versa.
  'comicScript.pacing': ({ comicPacingContent }) => canonicalStringify(comicPacingContent ?? null),
  // The panel-rhythm check's content (#1314) — LAYOUT ONLY: it reads nothing but
  // the per-page panel COUNT (splash/crowding/grid-monotony verdicts), so its
  // fingerprint is just the counts. A text-only edit (rewording a caption or
  // description without adding/removing a panel) must NOT stale a rhythm finding —
  // the verdict cannot have changed. Distinct from `comicScript.pacing` (which
  // hashes the text the page-turn LLM reads).
  'comicScript.layout': ({ comicLayoutContent }) => canonicalStringify(comicLayoutContent ?? null),
};

// Flatten the storyboard scenes across every issue into the `{ issueNumber, scene }`
// list the visual.shot-continuity check reads (#1315). Built off the already-loaded
// issues — no extra I/O. Only issues that actually have storyboard scenes contribute,
// so a series with no visual stage yields an empty list (the check's gate then skips).
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

// Project the collected storyboard scenes down to ONLY the fields the
// visual.shot-continuity check reads (#1315), for the staleness fingerprint —
// the scene's heading/slugline (its finding location) and each shot's grammar
// fields (`id`, `continuityFromShotId`, `screenDirection`, `shotType`,
// `description` — the anchorQuote source). Excludes render/status fields
// (`imageJobId`, `sceneVideoJobId`, wardrobe, …) so a finding stales only when
// the shot grammar it analyzed changes, not on an unrelated render. Mirrors
// `projectComicLetteringContent`. Type-guarded throughout (scenes ride peer sync).
function projectStoryboardContinuity(storyboardScenes) {
  return (Array.isArray(storyboardScenes) ? storyboardScenes : []).map(({ issueNumber, scene }) => ({
    issueNumber: Number.isInteger(issueNumber) ? issueNumber : null,
    heading: typeof scene?.heading === 'string' ? scene.heading : '',
    slugline: typeof scene?.slugline === 'string' ? scene.slugline : '',
    shots: (Array.isArray(scene?.shots) ? scene.shots : []).map((s) => ({
      id: typeof s?.id === 'string' ? s.id : '',
      continuityFromShotId: typeof s?.continuityFromShotId === 'string' ? s.continuityFromShotId : null,
      screenDirection: typeof s?.screenDirection === 'string' ? s.screenDirection : null,
      shotType: typeof s?.shotType === 'string' ? s.shotType : null,
      description: typeof s?.description === 'string' ? s.description : '',
    })),
  }));
}

// The three comic projections below all derive from the SAME parsed page list
// (`comicLetteringIssues(issues)` → `[{ number, pages }]`), so the caller parses
// the comic scripts ONCE (`comicIssuesFor(issues)`) and passes the rows in —
// rather than each projection re-parsing every issue's script. They take the
// already-parsed `comicIssues` rows, not raw `issues`.

// Lettering token (`comicScript`, #1313): keeps ONLY caption/dialogue/SFX — the
// fields `panelLetteringMetrics` consumes — so the hash is stable across image
// renders and description edits that don't change lettering. PAGE GROUPING is
// preserved: the check reports per-page totals/locations, so moving panels between
// pages must change the hash even when the lettering text is identical.
function projectComicLetteringContent(comicIssues) {
  return comicIssues.map(({ number, pages }) => ({
    number,
    pages: pages.map((p) => ({
      panels: (Array.isArray(p?.panels) ? p.panels : []).map((panel) => ({
        caption: typeof panel?.caption === 'string' ? panel.caption : '',
        dialogue: Array.isArray(panel?.dialogue) ? panel.dialogue : [],
        sfx: typeof panel?.sfx === 'string' ? panel.sfx : '',
      })),
    })),
  }));
}

// Page-turn token (`comicScript.pacing`, #1314): distinct from the lettering token
// so the two checks' fingerprints don't bleed — editing a panel's visual
// `description` must stale a page-turn finding (the LLM digest reads it) WITHOUT
// staling a lettering finding (which never reads it), and vice-versa. So this adds
// `description` on top of caption/dialogue/SFX. PAGE GROUPING preserved; render/
// status fields (`panel.imageJobId`) are never projected.
function projectComicPacingContent(comicIssues) {
  return comicIssues.map(({ number, pages }) => ({
    number,
    pages: pages.map((p) => ({
      panels: (Array.isArray(p?.panels) ? p.panels : []).map((panel) => ({
        description: typeof panel?.description === 'string' ? panel.description : '',
        caption: typeof panel?.caption === 'string' ? panel.caption : '',
        dialogue: Array.isArray(panel?.dialogue) ? panel.dialogue : [],
        sfx: typeof panel?.sfx === 'string' ? panel.sfx : '',
      })),
    })),
  }));
}

// Layout token (`comicScript.layout`, #1314): LAYOUT ONLY — the per-page panel
// COUNT — for the panel-rhythm check, which reads nothing but counts
// (`analyzePanelRhythm`). Fingerprinting only the count means a text-only edit
// (reword a caption/description without changing how many panels a page has) does
// NOT stale a rhythm finding, while adding/removing/moving a panel does. Per-page
// array order is preserved so a reordering that changes the run structure (splash
// runs, monotony) re-hashes.
function projectComicLayoutContent(comicIssues) {
  return comicIssues.map(({ number, pages }) => ({
    number,
    panelCounts: pages.map((p) => (Array.isArray(p?.panels) ? p.panels.length : 0)),
  }));
}

// Stable projection of the series editorial aggregate down to the arc fields a
// POV/arc check reads — drops the volatile `generatedAt` (and the rest) so the
// staleness fingerprint only moves when a character's detected arc actually does.
function projectEditorialArcs(editorial) {
  const chars = Array.isArray(editorial?.characters) ? editorial.characters : [];
  return chars.map((c) => ({
    name: c?.name || '',
    arcDirection: c?.arcDirection || 'flat',
    issueCount: Number.isFinite(c?.issueCount) ? c.issueCount : 0,
    isProtagonist: c?.isProtagonist === true,
  }));
}

// True only when every analyzable issue has a fresh, complete analysis — the
// signal pov.justified uses to tell "absent because arc-less" from "absent
// because not-yet-analyzed" (#1295). Injected into ctx for the check AND folded
// into the editorialArcs fingerprint above so a prose edit that stales coverage
// (without changing the arc projection) still stales the POV findings.
function editorialCoverageComplete(editorial) {
  const cov = editorial?.coverage;
  return !!cov && cov.withContent > 0 && cov.analyzed >= cov.withContent && (cov.stale || 0) === 0;
}
for (const token of EDITORIAL_SOURCES) {
  if (typeof SOURCE_RESOLVERS[token] !== 'function') {
    throw new Error(`checkRunner: editorial source "${token}" has no fingerprint resolver — keep SOURCE_RESOLVERS in sync with EDITORIAL_SOURCES`);
  }
}

// A check's declared sources, falling back to the legacy needsManuscript heuristic
// for any check synthesized before the declaration existed (e.g. an older custom
// check). Unknown tokens are dropped so a typo can't corrupt the hash.
function checkSources(check) {
  const declared = Array.isArray(check?.sources) && check.sources.length
    ? check.sources
    : (check?.needsManuscript ? ['manuscript', 'canon'] : ['canon']);
  return declared.filter((token) => SOURCE_RESOLVERS[token]);
}

// Resolve every source token's content ONCE for a given inputs object
// (`{ manuscript, canon, series }`), so fingerprinting many checks/comments doesn't
// re-stringify the canon per call. Returns a token→string map the fingerprint reads.
function resolveSources(inputs) {
  const resolved = {};
  for (const token of EDITORIAL_SOURCES) resolved[token] = SOURCE_RESOLVERS[token](inputs);
  return resolved;
}

// Fingerprint exactly the inputs a check reads, from a pre-resolved token→content
// map (see `resolveSources`). Tokens are de-duped and sorted so the hash is
// independent of declaration order; each segment is prefixed with its token so two
// source sets can't collide on equal content. NUL joins segments (it can't appear
// in the JSON the resolvers emit) so they can't run together ambiguously.
function fingerprintForCheck(check, resolved) {
  const segments = [...new Set(checkSources(check))]
    .sort()
    .map((token) => `${token}=${resolved[token]}`);
  // A custom check's run logic IS its authored prompt (user data, not code), so a
  // prompt edit must stale its prior findings even when the manuscript is unchanged
  // — fold it into the fingerprint. Built-in checks' logic lives in code (a code
  // change isn't user content and isn't fingerprinted), so only their declared
  // content sources matter. (#1346, #1387)
  if (check?.isCustom && typeof check.prompt === 'string') {
    segments.push(`definition=${check.prompt}`);
  }
  return sha256(segments.join(HASH_SEP));
}

// Output room reserved for an editorial check's findings JSON. Sized for the
// editorial output (a bounded findings list — far smaller than the completeness
// pass's full-page rewrites), NOT the 8_000-token contextBudget default: that
// default exceeds the 8_192-token fallback window, so inheriting it would drive
// the usable input budget to 0 on an unknown/small local provider — the exact
// case this chunking targets — and silently feed the model an empty manuscript.
const EDITORIAL_OUTPUT_RESERVE_TOKENS = 2_000;

/**
 * Run the enabled editorial checks for a series and seed their findings into the
 * manuscript review.
 *
 * @param {string} seriesId
 * @param {object} [options]
 *   - checkIds: string[] — run only this subset (default: all enabled)
 *   - settings: object — pre-loaded settings (default: read fresh)
 *   - providerOverride / modelOverride — forwarded to LLM checks
 *   - signal: AbortSignal — checked between checks for cancellation
 *   - onProgress: (event) => void — { type: 'check:start'|'check:complete', ... }
 * @returns {Promise<{ runId, findings, perCheck, canceled }>}
 */
export async function runEditorialChecks(seriesId, options = {}) {
  const { checkIds = null, providerOverride, modelOverride, signal, onProgress } = options;
  const settings = options.settings || await getSettings();
  const enabled = getEnabledChecks(settings, checkIds);

  const runId = randomUUID();
  if (enabled.length === 0) {
    return { runId, findings: [], perCheck: [], canceled: false };
  }

  // Build the shared context once — every check reads from this. Only pay the
  // manuscript section-collection I/O when an enabled check actually consumes
  // the stitched corpus (deterministic checks like naming use only the canon).
  const series = await getSeries(seriesId);
  const needsManuscript = enabled.some(({ check }) => check.needsManuscript);
  // Reverse-outline fetch is gated on the declared source (#1296) so a run with no
  // scene-segmentation check pays no extra I/O — mirrors the needsManuscript gate.
  // Either the scenes (`reverseOutline`) OR the plotline list (`reverseOutline.plotlines`,
  // #1310) is served by the same single outline fetch.
  const needsReverseOutline = enabled.some(({ check }) => {
    const sources = checkSources(check);
    return sources.includes('reverseOutline') || sources.includes('reverseOutline.plotlines');
  });
  // Editorial-arc fetch is gated on the declared source (#1295) so a run with no
  // POV/arc check pays no extra snapshot I/O — mirrors the needsReverseOutline gate.
  const needsEditorialArcs = enabled.some(({ check }) => checkSources(check).includes('editorialArcs'));
  // Issues are fetched only when an enabled check declares an issue-derived source
  // — storyboard.shots (#1315), comicScript (#1313, served via the comic.lettering
  // check's ctx.issues), or the comic-pacing tokens comicScript.pacing /
  // comicScript.layout (#1314, served via the same ctx.issues projection). All
  // projections feed off the same UNCAPPED per-series scan (#1469): listIssues caps
  // at ISSUES_PER_RESPONSE_MAX (1000), silently skipping every storyboard scene /
  // comic page past the 1000th issue. Mirrors the gate + fetch on the
  // getReviewWithStaleness path below.
  const needsIssues = enabled.some(({ check }) => {
    const sources = checkSources(check);
    return sources.includes('storyboard.shots')
      || sources.includes('comicScript')
      || sources.includes('comicScript.pacing')
      || sources.includes('comicScript.layout');
  });
  const [sections, canon, issues, outline, editorial] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
    needsIssues ? listIssuesForSeries(seriesId).catch(() => []) : Promise.resolve([]),
    needsReverseOutline ? getReverseOutline(seriesId).catch(() => null) : Promise.resolve(null),
    // Reuse the already-loaded series so the aggregate skips a redundant getSeries.
    // (issues is fetched in this same Promise.all, so it can't be passed here —
    // it's still in the temporal dead zone — and stays an internal fetch.)
    needsEditorialArcs ? getSeriesEditorial(seriesId, { series }).catch(() => null) : Promise.resolve(null),
  ]);
  const manuscript = sectionsCorpus(sections);
  // Storyboard shots for the visual.shot-continuity check (#1315) — projected off
  // the gated `issues` fetch (empty unless a storyboard.shots/comicScript check is on).
  const storyboardScenes = collectStoryboardScenes(issues);
  const reverseOutline = Array.isArray(outline?.scenes) ? outline.scenes : [];
  // The outline's plotline list (#1310) — injected separately from the scenes so a
  // plotline-reading check (plot.structure-momentum) can reconcile dropped subplots
  // against the author's tagged threads.
  const reverseOutlinePlotlines = Array.isArray(outline?.plotlines) ? outline.plotlines : [];
  const editorialArcs = projectEditorialArcs(editorial);
  // Whether every analyzable issue has been analyzed and is fresh — gates the
  // pov.justified "absent from detected arcs" finding so a partially-analyzed
  // series (canceled/early-stopped batch) doesn't flag a not-yet-analyzed POV
  // holder as arc-less (#1295). Folded into the editorialArcs fingerprint below.
  const editorialArcsComplete = editorialCoverageComplete(editorial);
  // The comic content the comic checks read — derived from the already-loaded
  // issues (no extra I/O). Parse each issue's comic script ONCE, then build all
  // three per-token projections from the shared rows: lettering (#1313,
  // caption/dialogue/SFX), pacing (#1314, + visual `description`), and layout
  // (#1314, panel counts only) — so a description edit stales a pacing finding
  // without staling a lettering one, and a text-only edit never stales a rhythm one.
  const comicIssues = comicLetteringIssues(issues);
  const comicScripts = projectComicLetteringContent(comicIssues);
  const comicPacingContent = projectComicPacingContent(comicIssues);
  const comicLayoutContent = projectComicLayoutContent(comicIssues);
  // Resolve every source token once — each finding's fingerprint reads from this
  // so the editor flags it `stale` when the content that check actually read (its
  // declared `sources`) drifts (#1345, #1387).
  const resolvedSources = resolveSources({ manuscript, canon, series, reverseOutline, reverseOutlinePlotlines, editorialArcs, editorialArcsComplete, storyboardScenes, comicScripts, comicPacingContent, comicLayoutContent });
  const baseCtx = {
    seriesId,
    series,
    issues,
    sections,
    manuscript,
    reverseOutline,
    reverseOutlinePlotlines,
    editorialArcs,
    editorialArcsComplete,
    storyboardScenes,
    canon,
    providerOverride,
    modelOverride,
    // The run's AbortSignal, so a multi-chunk LLM check can stop launching
    // further chunk calls mid-run (the runner only checks it before/after each
    // check.run()). Mirrors the per-chunk cancel check in the completeness pass.
    signal,
    // Injected LLM caller — keeps server/lib/editorial pure. Forwards the
    // provider/model overrides so an LLM check honors the autopilot's choice.
    callStagedLLM: (stage, vars, opts = {}) =>
      runStagedLLM(stage, vars, { providerOverride, modelOverride, ...opts }),
    // Injected inline-prompt caller for user-defined checks (#1346) whose prompt
    // body is authored from the UI (no shipped stage template). Same provider/
    // model overrides as callStagedLLM so a custom check honors the run's choice.
    callInlineLLM: (prompt, opts = {}) =>
      runInlineLLM(prompt, { providerOverride, modelOverride, ...opts }),
    // Inline-prompt caller that resolves the provider/model from a NAMED STAGE's
    // pin (#1403). The cross-chunk setup-summary call rides alongside a stage-
    // pinned manuscript check, so it must run on the SAME provider as that stage —
    // routing it through the active provider (plain callInlineLLM) could leak
    // manuscript text to a different (e.g. cloud) provider than the stage chose.
    callStageScopedInlineLLM: (stage, prompt, opts = {}) =>
      runStageScopedInlineLLM(stage, prompt, { providerOverride, modelOverride, ...opts }),
    // Injected manuscript chunker — plans the stitched manuscript into chunks
    // sized to `stage`'s resolved provider context window (reusing the same
    // budgeter as the completeness pass), so a long series is fully reviewed
    // instead of truncated on a small/local provider. Returns the chunk-corpus
    // strings (one for a whole-fits provider) for an LLM check to iterate.
    // Lives here (not the pure registry) because it resolves the provider.
    //
    // Two ways to declare per-chunk overhead:
    //   { overheadTokens }                — legacy: a fixed, non-trimmable overhead
    //                                       (the custom-check prompt wrapper).
    //   { context, fixedOverheadTokens }  — the trimmable re-sent context blocks
    //                                       (scene map, character arcs, …) plus the
    //                                       fixed template/contract overhead. The
    //                                       context is trimmed to GUARANTEE the
    //                                       manuscript a budget floor (#1459) so a
    //                                       large reverse outline on a small window
    //                                       can't starve the manuscript chunk to ''.
    // When `context` is given, the (possibly trimmed) blocks are attached to the
    // returned array as `.context` so the check feeds the trimmed values to the LLM.
    planManuscriptChunks: async (stage, { overheadTokens = 0, context = null, fixedOverheadTokens = 0 } = {}) => {
      if (!sections.length) return [];
      const { contextWindow } = await resolveStageContext(stage, { providerOverride, modelOverride });
      let effectiveOverhead = overheadTokens;
      let fittedContext = null;
      if (context && typeof context === 'object') {
        // Reserve no more than the manuscript actually needs: a short manuscript
        // that fits alongside the full context shouldn't get its context trimmed
        // just to hold open the full floor. Cap the reserved floor at the
        // manuscript's own token cost (the floor only bites a manuscript large
        // enough to want it).
        const floorTokens = Math.min(MANUSCRIPT_FLOOR_TOKENS, estimateTokens(manuscript));
        const fit = fitContextToManuscriptFloor(context, {
          contextWindow,
          fixedOverheadTokens,
          outputReserveTokens: EDITORIAL_OUTPUT_RESERVE_TOKENS,
          floorTokens,
        });
        effectiveOverhead = fit.overheadTokens;
        fittedContext = fit.context;
        if (fit.trimmed) {
          console.warn(`✂️ editorial context trimmed to keep manuscript budget — stage=${stage || 'inline'} window=${contextWindow}`);
        }
      }
      const plan = planManuscriptPass({
        contextWindow,
        // Each section's full contribution = header + body, matching sectionsCorpus.
        sections: sections.map((s) => ({ ...s, text: `${manuscriptSectionHeader(s)}\n\n${s.content || ''}` })),
        overheadTokens: effectiveOverhead,
        outputReserveTokens: EDITORIAL_OUTPUT_RESERVE_TOKENS,
      });
      // One whole chunk or many — the same usable-char budget caps each. Do NOT
      // floor this above plan.usableChars: on a genuinely small configured window
      // that would push the prompt back over the provider's context and get it
      // clipped/rejected. The editorial-sized output reserve above plus the
      // context floor (when context is given) is what keeps usableChars positive
      // on the common unknown/8K-fallback provider.
      const corpora = plan.mode === 'whole'
        ? [manuscript]
        : plan.chunks.map((c) => sectionsCorpus(c.sections));
      const chunks = corpora.map((c) => c.slice(0, plan.usableChars));
      // Expose the per-chunk budget so a cross-chunk-digest check can fit its
      // digest into each chunk's spare room without overflowing the window or
      // displacing manuscript text (see runChunkedManuscriptCheck).
      chunks.usableChars = plan.usableChars;
      // Expose the trimmed context so the check sends the SAME (possibly shrunk)
      // blocks it was budgeted for — sending the untrimmed originals would overflow
      // the window the trim was computed to fit.
      if (fittedContext) chunks.context = fittedContext;
      return chunks;
    },
  };

  const findings = [];
  const perCheck = [];
  let canceled = false;
  for (const { check, config } of enabled) {
    if (signal?.aborted) { canceled = true; break; }
    onProgress?.({ type: 'check:start', checkId: check.id, label: check.label });
    const ctx = { ...baseCtx, config, severityDefault: check.severityDefault };
    // Boundary try/catch: a check's run() calls into arbitrary logic / LLM
    // providers — one bad check must not abort the whole pass (mirrors the
    // per-comment fix guard in seriesAutopilot.runEditorial).
    try {
      if (typeof check.gate === 'function' && !check.gate(ctx)) {
        perCheck.push({ checkId: check.id, count: 0, skipped: true });
        onProgress?.({ type: 'check:complete', checkId: check.id, count: 0, skipped: true });
        continue;
      }
      const raw = (await check.run(ctx)) || [];
      const sourceContentHash = fingerprintForCheck(check, resolvedSources);
      const stamped = raw.map((f) => ({ ...f, checkId: check.id, sourceContentHash }));
      findings.push(...stamped);
      perCheck.push({ checkId: check.id, count: stamped.length });
      onProgress?.({ type: 'check:complete', checkId: check.id, count: stamped.length });
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 500);
      console.error(`❌ editorial check ${check.id} failed — series=${String(seriesId).slice(0, 12)} ${message}`);
      perCheck.push({ checkId: check.id, error: message });
      onProgress?.({ type: 'check:complete', checkId: check.id, error: message });
    }
    // Re-check AFTER the (possibly long-running LLM) check so a cancellation
    // during the final check is caught before the seed below — otherwise a
    // cancel mid-run would still persist the partial findings.
    if (signal?.aborted) { canceled = true; break; }
  }

  // Seed in 'merge' mode (never 'fresh'): a per-series seed of only the editorial
  // checks' findings must not auto-dismiss completeness or other-check open
  // comments. Merge dedups via findingKey (which now includes checkId) and keeps
  // dismissed findings suppressed per-check. Skip entirely on cancellation — a
  // canceled run emits a `canceled` terminal event and must not mutate the
  // review with partial findings collected before the abort.
  if (!canceled) {
    // Seed only when there are findings (merge dedups); but record a revision-trend
    // snapshot for EVERY non-canceled run (#1316) — a run is a revision boundary,
    // and a CLEAN run (0 new findings, or fixes that closed prior ones) is exactly
    // the improving point the trend should capture. When findings were seeded we
    // pass the just-merged comments (no re-read); otherwise recordTrendSnapshot
    // reads the current review itself. Best-effort — a ledger write must never
    // fail the check run (it's telemetry).
    const review = findings.length
      ? await seedReviewFromFindings(seriesId, findings, { runId, mode: 'merge' })
      : null;
    const gate = readReadinessGate(settings) || undefined;
    await recordTrendSnapshot(seriesId, { runId, gate, comments: review?.comments }).catch((err) => {
      console.error(`⚠️ editorial trend snapshot failed — series=${String(seriesId).slice(0, 12)} ${err.message}`);
    });
  }
  return { runId, findings, perCheck, canceled };
}

/**
 * Dry-run preview: which checks would run for the current settings (+ optional
 * subset), without executing them. Used by the run route's plan response and by
 * callers that want to show the user what's enabled.
 */
export async function buildEditorialCheckPlan(seriesId, { checkIds = null, settings } = {}) {
  const resolved = settings || await getSettings();
  const checks = getEnabledCheckRows(resolved, checkIds)
    .map((row) => ({ id: row.id, label: row.label, kind: row.kind, scope: row.scope }));
  return { seriesId, checks, enabledCount: checks.length };
}

/**
 * Read the manuscript review and annotate each editorial-check finding with a
 * `stale` flag (#1345): true when the content the check analyzed has changed
 * since the finding was seeded. Mirrors `editorialAnalysis.isSnapshotStale` —
 * recompute the current source hash and compare against the one stamped on the
 * finding. Findings without a `sourceContentHash` (completeness-pass comments,
 * older peers, legacy records) or whose check is no longer registered are left
 * unannotated → the UI treats absent `stale` as not-stale.
 *
 * Staleness is derived per-read (never stored), so it stays local to each
 * install's current content and never rides the synced review document.
 */
export async function getReviewWithStaleness(seriesId) {
  const review = await getReview(seriesId);
  // Resolve checks against built-ins + the user's custom checks (#1346) so a
  // custom-check finding still gets staleness annotation. Build the id→check map
  // once (custom-check synthesis is not free) and look up per comment.
  const settings = await getSettings();
  const byId = new Map(getAllChecks(settings).map((c) => [c.id, c]));
  const checkFor = (id) => byId.get(id) || null;
  // Only recompute hashes when there's at least one hash-stamped finding from a
  // still-registered check — a pure completeness review pays no extra I/O.
  const evaluable = review.comments.filter((c) => c.checkId && c.sourceContentHash && checkFor(c.checkId));
  if (!evaluable.length) return review;
  // Only pay the manuscript-collection I/O when an evaluable check declares it as
  // a source (mirrors the run path's gate, now source-derived rather than the bare
  // needsManuscript flag so it stays correct as the source vocabulary grows).
  const needsManuscript = evaluable.some((c) => checkSources(checkFor(c.checkId)).includes('manuscript'));
  const needsReverseOutline = evaluable.some((c) => {
    const sources = checkSources(checkFor(c.checkId));
    return sources.includes('reverseOutline') || sources.includes('reverseOutline.plotlines');
  });
  const needsEditorialArcs = evaluable.some((c) => checkSources(checkFor(c.checkId)).includes('editorialArcs'));
  // Issues are fetched here only when a storyboard-shots (#1315) OR comic-script
  // (#1313 lettering / #1314 pacing) finding needs re-fingerprinting — all derive
  // from the issue records, so a single gated fetch serves them. Mirrors the other
  // per-source I/O gates.
  const needsStoryboards = evaluable.some((c) => checkSources(checkFor(c.checkId)).includes('storyboard.shots'));
  const needsComicScript = evaluable.some((c) => {
    const s = checkSources(checkFor(c.checkId));
    return s.includes('comicScript') || s.includes('comicScript.pacing') || s.includes('comicScript.layout');
  });
  const needsIssues = needsStoryboards || needsComicScript;
  const series = await getSeries(seriesId);
  const [sections, canon, outline, editorial, issues] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
    needsReverseOutline ? getReverseOutline(seriesId).catch(() => null) : Promise.resolve(null),
    // Reuse the already-loaded series.
    needsEditorialArcs ? getSeriesEditorial(seriesId, { series }).catch(() => null) : Promise.resolve(null),
    needsIssues ? listIssuesForSeries(seriesId).catch(() => []) : Promise.resolve([]),
  ]);
  const reverseOutline = Array.isArray(outline?.scenes) ? outline.scenes : [];
  const reverseOutlinePlotlines = Array.isArray(outline?.plotlines) ? outline.plotlines : [];
  const editorialArcs = projectEditorialArcs(editorial);
  const editorialArcsComplete = editorialCoverageComplete(editorial);
  const storyboardScenes = collectStoryboardScenes(issues);
  const comicIssues = comicLetteringIssues(issues);
  const comicScripts = projectComicLetteringContent(comicIssues);
  const comicPacingContent = projectComicPacingContent(comicIssues);
  const comicLayoutContent = projectComicLayoutContent(comicIssues);
  const resolvedSources = resolveSources({ manuscript: sectionsCorpus(sections), canon, series, reverseOutline, reverseOutlinePlotlines, editorialArcs, editorialArcsComplete, storyboardScenes, comicScripts, comicPacingContent, comicLayoutContent });
  return {
    ...review,
    comments: review.comments.map((c) => {
      const check = c.checkId && c.sourceContentHash ? checkFor(c.checkId) : null;
      if (!check) return c;
      const current = fingerprintForCheck(check, resolvedSources);
      return { ...c, stale: c.sourceContentHash !== current };
    }),
  };
}

// ---------------------------------------------------------------------------
// SSE run-tracking — shared lifecycle via createSseRunner (server/lib/sseUtils.js),
// the same factory backing manuscriptCompletenessRunner + editorialAnalysisRunner.
// ---------------------------------------------------------------------------

const runner = createSseRunner({ logLabel: 'editorial checks' });

export function isEditorialChecksActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelEditorialChecks(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off a streamed editorial-checks run. Returns the runId immediately;
 * progress lands via SSE. Re-calling while a run is in flight resolves to the
 * existing runId.
 */
export function startEditorialChecksRun(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await runEditorialChecks(seriesId, {
      checkIds: options.checkIds,
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      signal,
      onProgress: (event) => broadcast({ ...event, runId }),
    });
    if (record.cancelRequested || result.canceled) {
      broadcast({ type: 'canceled', runId, canceledAt: new Date().toISOString() });
      console.log(`📝 editorial checks canceled — series=${String(seriesId).slice(0, 12)}`);
      return;
    }
    broadcast({
      type: 'complete',
      runId,
      findingCount: result.findings.length,
      perCheck: result.perCheck,
      completedAt: new Date().toISOString(),
    });
    console.log(`📝 editorial checks complete — series=${String(seriesId).slice(0, 12)} findings=${result.findings.length}`);
  });
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
