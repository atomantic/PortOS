// Editorial checks — research group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  FACT_ACCURACY_STAGE,
  THEME_COHERENCE_STAGE,
  declaredThemesSummary,
  runManuscriptLlmCheck,
  sceneGroundingSummary,
  z,
} from '../checkInfra.js';

export const researchChecks = [
  {
    id: 'research.fact-accuracy',
    sources: ['manuscript', 'series.factReference'],
    label: 'Research / fact accuracy',
    description:
      'LLM scan for contradictions to real-world facts the author has documented — a grounded historical, scientific, or geographic claim the prose gets wrong (a city placed in the wrong country, a date that predates the technology it describes, a physiologically impossible feat). Distinct from the internal timeline/canon-contradiction check: this reconciles the prose against EXTERNAL truth, not the story bible. Opt-in and gated — it runs only when the series is flagged fact-critical AND the author has supplied a fact reference, so it never second-guesses deliberate invention in pure fantasy.',
    scope: 'series',
    kind: 'llm',
    category: 'accuracy',
    // Fallback severity when the model omits one. A factual howler in grounded
    // fiction is a credibility killer, but the prompt directs the model to mark a
    // plot-relevant error 'high' per finding, so the worst cases still surface high.
    severityDefault: 'medium',
    // Registry-enabled like every other built-in check, but the GATE is the real
    // opt-in: it produces findings ONLY when the series is flagged fact-critical
    // AND a reference is supplied — mirroring how the comic/visual checks are
    // defaultEnabled:true yet skip a prose-only series via their content gate. A
    // `defaultEnabled: false` here would mean the series fact-critical flag alone
    // never triggers it, because getEnabledChecks() filters disabled checks out
    // BEFORE the per-series gate runs — so the advertised "flag the series" path
    // would silently do nothing until the user ALSO enabled it in check settings.
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a long manuscript can not flood the review.',
      },
    ],
    // Gate on BOTH the per-series fact-critical opt-in AND a non-empty author
    // fact reference (plus a non-empty manuscript). Without a reference there's
    // nothing authoritative to reconcile against, and the flag keeps the check
    // off for fantasy where "wrong" real-world facts may be intentional.
    gate: (ctx) =>
      ctx.series?.factCritical === true
      && (ctx.series?.factReference || '').trim().length > 0
      && (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // The author's documented real-world facts are the authoritative reference
      // the prose is judged against — fixed per-call overhead re-sent on each
      // chunk. Trimmed largest-first if the manuscript needs the room.
      const factReference = (ctx.series?.factReference || '').trim();
      return runManuscriptLlmCheck(ctx, {
        stage: FACT_ACCURACY_STAGE,
        category: 'accuracy',
        context: { factReference },
        buildVars: (manuscript, _meta, c) => ({
          manuscript,
          factReference: c.factReference,
        }),
      });
    },
  },
  {
    id: 'theme.coherence',
    sources: ['manuscript', 'series.arc.themes', 'reverseOutline'],
    label: 'Theme coherence / thematic throughline',
    description:
      'Checks whether the manuscript actually DELIVERS its declared themes (series.arc.themes), not just states them. For each authored theme it maps where the story sets it up, complicates it, and pays it off — flagging a theme that is stated but never dramatized, or dropped after the opening. Detects a strong EMERGENT theme the story is really telling that is not in the arc (offers to add it), and checks that the climax/resolution lands the thematic argument (vs. resolving plot but not theme). Reads the reverse-outline scene map to attribute setup/payoff to scenes; degrades to a whole-manuscript scan when no outline or no themes exist.',
    scope: 'series',
    kind: 'llm',
    category: 'theme',
    severityDefault: 'medium',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a long manuscript can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // Both blocks are fixed per-call overhead (re-sent on each chunk) and pure
      // context: the declared themes let the model build a per-theme setup/
      // complication/payoff coverage map and reconcile detected vs. authored
      // themes; the scene map lets it attribute setup/payoff to a scene + issue.
      // The check degrades gracefully — no authored themes ⇒ {{#declaredThemes}}
      // renders nothing and the check works from the prose alone to surface a
      // strong emergent theme; no outline ⇒ {{#sceneMap}} renders nothing.
      const declaredThemes = declaredThemesSummary(ctx.series?.arc?.themes);
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: THEME_COHERENCE_STAGE,
        category: 'theme',
        // declaredThemes is bounded by the authored theme count; sceneMap grows with
        // scene count — so largest-first trimming absorbs the cut into sceneMap.
        context: { declaredThemes, sceneMap },
        // `isFinal` gates the whole-corpus judgments — a theme that is set up but
        // never paid off, a theme dropped after the opening, and whether the
        // climax lands the thematic argument can only be judged once the whole
        // manuscript is in view; an earlier chunk can't know a theme is paid off
        // later, so it would false-flag.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          declaredThemes: c.declaredThemes,
          sceneMap: c.sceneMap,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // Theme coverage accrues across the whole manuscript — the findings digest
        // keeps prior findings in view so a later chunk doesn't re-flag, and the
        // clean-setup digest rolls forward which themes have been set up /
        // complicated so a later payoff isn't mis-read as a dropped theme.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus: 'For each declared theme, note where it has been set up or complicated so far '
          + 'and whether it has been paid off yet; and note any strong EMERGENT theme the story '
          + 'is dramatizing that is not in the declared list, so a later chunk can tell a genuinely '
          + 'dropped/undramatized theme from one whose payoff simply has not arrived yet.',
      });
    },
  },
];
