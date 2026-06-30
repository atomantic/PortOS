// Editorial checks — comic group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  COMIC_PAGE_TURN_STAGE,
  COMIC_PROSE_SYNC_STAGE,
  DEFAULT_LETTERING_THRESHOLDS,
  analyzeBalloonAttribution,
  analyzeComicLettering,
  analyzePanelRhythm,
  authoredRevealSummary,
  balloonAttributionFinding,
  comicLetteringFinding,
  comicLetteringIssues,
  comicPageTurnSummary,
  hasComicContent,
  mapLlmFindings,
  proseSyncPairs,
  z,
} from '../checkInfra.js';

export const comicChecks = [
  {
    id: 'comic.lettering-density',
    sources: ['comicScript'],
    label: 'Comic lettering density / balloon load',
    description:
      'Flags over-stuffed comic panels — the #1 reader gripe in comics: a wall of text crammed into one balloon, too many balloons fighting for room, or a page whose total lettering load overwhelms the art. Parses each issue\'s comic script and counts words + balloons per panel and per page against configurable industry rules-of-thumb.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'lettering',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // Per-balloon word ceiling (~20–25 reads cleanly; much past it is a wall of text).
      maxWordsPerBalloon: z.number().int().min(1).max(200).default(DEFAULT_LETTERING_THRESHOLDS.maxWordsPerBalloon),
      // Per-panel total lettering word ceiling (dialogue + caption + SFX).
      maxWordsPerPanel: z.number().int().min(1).max(500).default(DEFAULT_LETTERING_THRESHOLDS.maxWordsPerPanel),
      // Distinct balloons (dialogue + caption boxes) a single panel reads cleanly with.
      maxBalloonsPerPanel: z.number().int().min(1).max(20).default(DEFAULT_LETTERING_THRESHOLDS.maxBalloonsPerPanel),
      // Whole-page lettering word ceiling — past it the text load buries the art.
      maxWordsPerPage: z.number().int().min(1).max(2000).default(DEFAULT_LETTERING_THRESHOLDS.maxWordsPerPage),
    }),
    configFields: [
      {
        key: 'maxWordsPerBalloon',
        label: 'Max words per balloon',
        type: 'number',
        min: 1,
        max: 200,
        step: 1,
        help: 'Flag a single speech balloon / caption box over this many words (~25 is the industry rule-of-thumb).',
      },
      {
        key: 'maxWordsPerPanel',
        label: 'Max words per panel',
        type: 'number',
        min: 1,
        max: 500,
        step: 1,
        help: 'Flag a panel whose total lettering (dialogue + caption + SFX) exceeds this many words (~50).',
      },
      {
        key: 'maxBalloonsPerPanel',
        label: 'Max balloons per panel',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        help: 'Flag a panel with more than this many distinct balloons + caption boxes (~3).',
      },
      {
        key: 'maxWordsPerPage',
        label: 'Max words per page',
        type: 'number',
        min: 1,
        max: 2000,
        step: 10,
        help: 'Flag a page whose total lettering load would overwhelm the art (~150).',
      },
    ],
    // Needs at least one issue with comic content (an edited page split or a
    // generated script). A cheap presence test — run() builds the full parsed
    // projection only when the gate passes.
    gate: (ctx) => hasComicContent(ctx.issues),
    run: (ctx) => {
      const config = ctx.config || {};
      const findings = [];
      for (const { number, pages } of comicLetteringIssues(ctx.issues)) {
        for (const v of analyzeComicLettering(pages, config)) {
          findings.push(comicLetteringFinding(v, number));
        }
      }
      return findings;
    },
  },
  {
    id: 'comic.balloon-attribution',
    // Reads each panel's DESCRIPTION (to decide if the speaker is shown) and the
    // canon cast (for the visible-other severity), so it must fingerprint both:
    // `comicScript.pacing` covers description + dialogue (the bare `comicScript`
    // token is lettering-only and would leave a finding stale after a description
    // edit), and `canon` covers name/alias changes.
    sources: ['comicScript.pacing', 'canon'],
    label: 'Comic speech-balloon attribution',
    description:
      'Flags a comic dialogue line whose speaker is not shown in the panel and carries no off-panel/broadcast cue — the image model then letters a normal balloon and tails it to whoever IS drawn, mis-attributing the line (e.g. a station-AI PA line pointed at a visible bystander). Parses each issue\'s comic script and checks every panel\'s dialogue speakers against the panel description and the canon cast.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({}),
    configFields: [],
    // Same cheap presence gate as the lettering check — needs at least one issue
    // with comic content; canon is read from ctx for the visible-cast match.
    gate: (ctx) => hasComicContent(ctx.issues),
    run: (ctx) => {
      const characterNames = (ctx.canon?.characters || [])
        .filter((c) => c && typeof c === 'object')
        .flatMap((c) => [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])])
        .filter((n) => typeof n === 'string' && n.trim());
      const findings = [];
      for (const { number, pages } of comicLetteringIssues(ctx.issues)) {
        for (const v of analyzeBalloonAttribution(pages, { characterNames })) {
          findings.push(balloonAttributionFinding(v, number));
        }
      }
      return findings;
    },
  },
  {
    id: 'comic.prose-sync',
    // Reads each issue's PROSE-stage text (`prose`) and its authoritative COMIC
    // content (`comicScript.pacing` — description + dialogue + caption + SFX), BOTH
    // off the already-loaded issue records. Declaring `prose` (not `manuscript`) is
    // load-bearing: the stitched manuscript picks comicScript over prose for a hybrid
    // issue, so a `manuscript` source would compare the comic against itself. Both
    // tokens are fingerprinted so a finding stales when either the prose or the comic
    // for that issue drifts; both also make the runner fetch the per-issue `issues`.
    sources: ['prose', 'comicScript.pacing'],
    label: 'Comic ↔ prose synchronization (hybrid issues)',
    description:
      'LLM cross-media check for hybrid comic+prose issues: pairs each issue\'s prose narration with its authoritative comic pages and flags SUBSTANTIVE divergences — a plot beat the prose narrates that no panel shows, panel dialogue that contradicts the prose (different words or a different speaker), or a chronology disagreement (events ordered differently across the two media). Comics legitimately compress and cut, so it flags only material mismatches, not ordinary medium-translation trims. Runs one model call per issue that has both prose and comic content, anchoring every finding to its issue.',
    scope: 'issue',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({
      // Cap findings per issue so a long issue can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
      // Cap how many hybrid issues are cross-checked per run (one LLM call each),
      // so a long series can't fan out into an unbounded number of calls. 0 = no cap.
      maxIssues: z.number().int().min(0).max(500).default(40),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per issue',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings per issue so a long issue can not flood the review.',
      },
      {
        key: 'maxIssues',
        label: 'Max issues cross-checked per run',
        type: 'number',
        min: 0,
        max: 500,
        step: 1,
        help: 'Cap how many hybrid issues are compared per run (one model call each). 0 disables the cap.',
      },
    ],
    // Skip the LLM entirely unless at least one issue has BOTH prose and comic
    // content to cross-check.
    gate: (ctx) => proseSyncPairs(ctx).length > 0,
    run: async (ctx) => {
      const pairs = proseSyncPairs(ctx);
      if (!pairs.length) return [];
      const maxIssues = ctx.config?.maxIssues ?? 40;
      const scanned = maxIssues > 0 ? pairs.slice(0, maxIssues) : pairs;
      const maxFindings = ctx.config?.maxFindings ?? 12;
      const findings = [];
      for (const { number, prose, comic } of scanned) {
        // The runner only checks the abort signal before/after each check.run, so a
        // multi-issue loop honors it between issues to stop launching further calls.
        if (ctx.signal?.aborted) break;
        const { content } = await ctx.callStagedLLM(
          COMIC_PROSE_SYNC_STAGE,
          { issueNumber: number, prose, comic },
          { returnsJson: true, source: COMIC_PROSE_SYNC_STAGE },
        );
        // We KNOW which issue is under comparison, so force the issue anchor — a
        // model that omits or garbles issueNumber still attributes correctly.
        const mapped = mapLlmFindings(content?.findings, {
          severityDefault: ctx.severityDefault,
          category: 'continuity',
          max: maxFindings,
          withIssueNumber: true,
        }).map((f) => ({ ...f, issueNumber: number }));
        findings.push(...mapped);
      }
      return findings;
    },
  },
  {
    id: 'comic.panel-rhythm',
    sources: ['comicScript.layout'],
    label: 'Comic panel rhythm & splash usage',
    description:
      'Deterministic scan of each issue\'s parsed comic-page layout for reading-rhythm problems: splash-page overuse (too high a share of full-page splashes), back-to-back splashes that blow the page budget, overcrowded pages that cram too many beats, and monotonous grids (the same multi-panel count repeated page after page). Reads the parsed comic script (page → panel breakdown), not the prose manuscript.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'pacing',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // Panels above this on one page reads as overcrowded / decompression-killing.
      maxPanelsPerPage: z.number().int().min(2).max(20).default(9),
      // Share of full-page splashes at/above which (with >1 splash) splash overuse fires.
      splashRatioWarn: z.number().min(0.05).max(1).default(0.25),
      // Identical multi-panel count repeated for this many pages reads as grid monotony.
      monotonyRunLength: z.number().int().min(2).max(12).default(4),
      // Cap findings per run so a long run of issues can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      { key: 'maxPanelsPerPage', label: 'Max panels per page', type: 'number', min: 2, max: 20, step: 1, help: 'Panels above this on one page reads as overcrowded — too many beats compressed onto a single page.' },
      { key: 'splashRatioWarn', label: 'Splash overuse ratio', type: 'number', min: 0.05, max: 1, step: 0.05, help: 'Share of full-page splashes (with more than one splash) at/above which the issue is flagged for splash overuse.' },
      { key: 'monotonyRunLength', label: 'Grid monotony run length', type: 'number', min: 2, max: 12, step: 1, help: 'The same multi-panel page count repeated for this many pages in a row reads as a monotonous grid.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a long run of comic issues can not flood the review.' },
    ],
    // Needs at least one issue with analyzable comic content — shares the
    // cheap presence test with the lettering-density check (#1313).
    gate: (ctx) => hasComicContent(ctx.issues),
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      // Reuse the shared parsed-pages projection (#1313) the lettering check reads
      // off ctx.issues — prefers the edited comic-pages split over the generated
      // script — so both comic checks analyze identical page/panel structure.
      const rows = comicLetteringIssues(ctx.issues);
      const findings = [];
      for (const { number, pages } of rows) {
        if (findings.length >= max) break;
        const r = analyzePanelRhythm(pages, cfg);
        const location = Number.isInteger(number) ? `Issue ${number}` : 'Comic script';
        const issueNum = Number.isInteger(number) ? number : null;
        const push = (severity, problem, suggestion) => {
          if (findings.length >= max) return;
          findings.push({ severity, category: 'pacing', location, problem, suggestion, anchorQuote: '', issueNumber: issueNum });
        };
        if (r.splashOveruse) {
          push(
            ctx.severityDefault,
            `${r.splashPages.length} of ${r.totalPages} pages are full-page splashes (${Math.round(r.splashRatio * 100)}%, pages ${r.splashPages.join(', ')}) — splashes spent this freely lose their impact and burn the page budget on low-movement beats.`,
            'Reserve splash pages for the issue\'s biggest reveals or establishing shots; break the rest into multi-panel pages so each splash lands.',
          );
        }
        for (const run of r.backToBackSplashes) {
          push(
            ctx.severityDefault,
            `Pages ${run.startPage}–${run.endPage} are ${run.length} splash pages in a row — consecutive full-page splashes read as a slideshow and spend the page count fast.`,
            'Intercut multi-panel pages between the splashes, or collapse the run to the single strongest splash.',
          );
        }
        for (const page of r.overcrowded) {
          push(
            ctx.severityDefault,
            `Page ${page.pageNumber} has ${page.panelCount} panels — past roughly ${cfg.maxPanelsPerPage ?? 9} panels a page cramps each beat and the art has no room to breathe.`,
            'Split the page in two or cut the lowest-value panels so the key beats get space.',
          );
        }
        for (const run of r.monotonyRuns) {
          push(
            ctx.severityDefault,
            `Pages ${run.startPage}–${run.endPage} all use the same ${run.panelCount}-panel grid (${run.length} pages running) — an unvarying grid flattens the reading rhythm.`,
            'Vary the panel count — open up a beat with fewer, larger panels or compress a fast exchange — so the page rhythm tracks the story\'s.',
          );
        }
      }
      return findings;
    },
  },
  {
    id: 'comic.page-turn-beats',
    sources: ['comicScript.pacing', 'series.arc.readerMap'],
    label: 'Comic page-turn beat placement (LLM)',
    description:
      'LLM scan of each issue\'s comic-page layout for reveals and cliffhangers placed where the reader can see them early. On a two-page spread both pages are visible at once, so a surprise on a page the reader has already been looking at is spoiled before they reach it — a big reveal should land on the first page after a page turn (the start of the next spread). Reconciles the placement against the authored reader-map reveals/cliffhangers and suggests which panel to move.',
    scope: 'issue',
    kind: 'llm',
    category: 'pacing',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // Cap findings per run so a long run of issues can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a long run of comic issues can not flood the review.' },
    ],
    // Needs at least one issue with analyzable comic content — shares the
    // cheap presence test with the lettering-density check (#1313).
    gate: (ctx) => hasComicContent(ctx.issues),
    run: async (ctx) => {
      const max = ctx.config?.maxFindings ?? 12;
      // Authored reveals/cliffhangers are pure series-level context the model
      // reconciles each issue's placement against; '' when nothing is authored.
      const authoredReveals = authoredRevealSummary(ctx.series?.arc?.readerMap);
      // Same shared parsed-pages projection (#1313) the panel-rhythm + lettering
      // checks read off ctx.issues.
      const rows = comicLetteringIssues(ctx.issues);
      const findings = [];
      for (const { number, pages } of rows) {
        if (ctx.signal?.aborted || findings.length >= max) break;
        const pageLayout = comicPageTurnSummary(pages, number);
        if (!pageLayout) continue;
        const { content } = await ctx.callStagedLLM(
          COMIC_PAGE_TURN_STAGE,
          { pageLayout, authoredReveals },
          { returnsJson: true, source: COMIC_PAGE_TURN_STAGE },
        );
        const issueNum = Number.isInteger(number) ? number : null;
        const mapped = mapLlmFindings(content?.findings, {
          severityDefault: ctx.severityDefault,
          category: 'pacing',
          max: max - findings.length,
          withIssueNumber: false,
        });
        // The page-turn check runs per-issue, so attribute every finding to the
        // issue whose layout the model just read (the prompt has no issue header
        // for the model to echo back like the manuscript checks do).
        for (const f of mapped) findings.push({ ...f, issueNumber: issueNum });
      }
      return findings;
    },
  },
];
