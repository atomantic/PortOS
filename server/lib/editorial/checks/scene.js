// Editorial checks — scene group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  EDITORIAL_PROMPT_OVERHEAD_TOKENS,
  ENDINGS_CLIFFHANGER_STAGE,
  INTERIORITY_BALANCE_STAGE,
  OPENING_START_STAGE,
  PACING_ESCALATION_STAGE,
  PLOT_STRUCTURE_STAGE,
  REACTION_PROPORTIONALITY_STAGE,
  SENSORY_BALANCE_STAGE,
  WHITE_ROOM_STAGE,
  authoredCliffhangerSummary,
  authoredSetupPayoffSummary,
  conflictIntensityTally,
  plotlineCoverageSummary,
  runManuscriptLlmCheck,
  sceneComponentMix,
  sceneGroundingSummary,
  sceneLabel,
  z,
} from '../checkInfra.js';

export const sceneChecks = [
  {
    id: 'scene.component-balance',
    sources: ['reverseOutline'],
    label: 'Scene component balance (narrative / action / dialogue)',
    description:
      'Flags scenes that lean on a single mode — a wall of narration, talking heads with no action, or pure action with no interiority or voice. Reads the reverse-outline scene segmentation; a balanced scene mixes at least two of narrative, action, and dialogue.',
    scope: 'scene',
    kind: 'deterministic',
    category: 'pacing',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // Minimum distinct components (narrative/action/dialogue) a scene should
      // carry. Default 2 (the "at least 2 of 3" rule); 3 demands all three; 1
      // disables the check (every scene with any signal trivially passes).
      minComponents: z.number().int().min(1).max(3).default(2),
    }),
    configFields: [
      {
        key: 'minComponents',
        label: 'Minimum scene components',
        type: 'number',
        min: 1,
        max: 3,
        step: 1,
        help: 'How many of narrative / action / dialogue a scene should mix. 2 flags single-mode scenes (a narration wall, talking heads, pure action); 3 demands all three; 1 disables the check.',
      },
    ],
    // Needs a generated reverse outline with at least one scene to read.
    gate: (ctx) => Array.isArray(ctx.reverseOutline) && ctx.reverseOutline.length > 0,
    run: (ctx) => {
      const minComponents = ctx.config?.minComponents ?? 2;
      if (minComponents <= 1) return []; // disabled — every classified scene passes
      const scenes = Array.isArray(ctx.reverseOutline) ? ctx.reverseOutline : [];
      const findings = [];
      for (const s of scenes) {
        if (!s || typeof s !== 'object') continue;
        const { present, missing } = sceneComponentMix(s.components);
        // Skip unclassified scenes (no component signal at all) — absent ≠ "zero
        // components"; flagging them would be a false positive on older outlines.
        if (present.length === 0 || present.length >= minComponents) continue;
        const label = sceneLabel(s);
        const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
        // How many more modes reach the configured target, and whether ALL the
        // missing ones are required to get there — so the guidance honors
        // minComponents=3 (a single-mode scene must add BOTH missing modes, not one).
        const needed = minComponents - present.length;
        const addJoiner = needed >= missing.length ? ' and ' : ' or ';
        const problem = present.length === 1
          ? `Scene "${label}" is all ${present[0]} — no ${missing.join(' or ')}. A single-mode scene reads flat; aim for at least ${minComponents} of narrative, action, and dialogue.`
          : `Scene "${label}" has ${present.join(' and ')} but no ${missing.join(' or ')} — only ${present.length} of the ${minComponents} components you expect.`;
        findings.push({
          severity: ctx.severityDefault,
          category: 'pacing',
          location: issueNumber != null ? `Issue ${issueNumber}: ${label}` : `Scene: ${label}`,
          problem,
          suggestion: `Add ${missing.join(addJoiner)} so the scene isn't a ${present.join('/')}-only beat (e.g. ground talking heads in the room, give a narration wall a beat of action, or let an action scene breathe with a line of dialogue or interiority).`,
          anchorQuote: typeof s.anchorQuote === 'string' ? s.anchorQuote : '',
          issueNumber,
        });
      }
      return findings;
    },
  },
  {
    id: 'sensory.balance',
    sources: ['manuscript', 'reverseOutline'],
    label: 'Sensory balance (all-visual / sensory-bare scenes)',
    description:
      'Flags scenes that lean almost entirely on sight while sound, smell, touch, and taste are neglected, and sensory-bare scenes with almost no concrete grounding. Reads the stitched manuscript plus the reverse-outline scene segmentation as context, naming the missing sense per finding.',
    scope: 'scene',
    kind: 'llm',
    category: 'style',
    severityDefault: 'low',
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
      // The scene map is fixed per-call overhead (re-sent on each chunk). It's
      // context only — the check degrades gracefully to a whole-issue scan when
      // no reverse outline exists (the prompt's {{#sceneMap}} renders nothing).
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: SENSORY_BALANCE_STAGE,
        category: 'style',
        context: { sceneMap },
        buildVars: (manuscript, _meta, c) => ({ manuscript, sceneMap: c.sceneMap }),
      });
    },
  },
  {
    id: 'scene.white-room',
    sources: ['manuscript', 'reverseOutline'],
    label: 'White-room / ungrounded scene',
    description:
      'Flags "white-room" scenes — dialogue and action in an undescribed void with no setting, blocking, or spatial grounding. Reads the stitched manuscript plus the reverse-outline scene segmentation, using each scene\'s recorded setting as a candidate signal. Distinct from sensory balance (senses) and scene-component balance (narrative/action/dialogue mix) — the gap here is specifically spatial grounding.',
    scope: 'scene',
    kind: 'llm',
    category: 'style',
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
      // The scene map is fixed per-call overhead (re-sent on each chunk). Each
      // scene's recorded `setting` is a strong white-room signal (blank ⇒ likely
      // ungrounded); the check degrades to a whole-issue scan when no outline exists.
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: WHITE_ROOM_STAGE,
        category: 'style',
        context: { sceneMap },
        buildVars: (manuscript, _meta, c) => ({ manuscript, sceneMap: c.sceneMap }),
      });
    },
  },
  {
    id: 'scene.interiority-balance',
    sources: ['manuscript', 'reverseOutline'],
    label: 'Interiority balance (visually dense / emotionally empty scenes)',
    description:
      'Flags scenes that are description-dense yet emotionally empty — prose heavy on setting, blocking, and physical detail but light on the viewpoint character\'s reaction, emotion, or thought, so description swamps interiority ("500 words of setting, zero POV reaction"). Judges the description-to-interiority ratio within each scene. Reads the stitched manuscript plus the reverse-outline scene segmentation, degrading to a whole-issue scan when no outline exists. Distinct from sensory balance (which weighs the five senses) and from interiority.protagonist (which flags whole-issue interiority absence) — the gap here is the in-scene balance: vivid outside, empty inside.',
    scope: 'scene',
    kind: 'llm',
    category: 'style',
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
      // The scene map is fixed per-call overhead (re-sent on each chunk). It's
      // context only — the check degrades gracefully to a whole-issue scan when
      // no reverse outline exists (the prompt's {{#sceneMap}} renders nothing).
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: INTERIORITY_BALANCE_STAGE,
        category: 'style',
        context: { sceneMap },
        buildVars: (manuscript, _meta, c) => ({ manuscript, sceneMap: c.sceneMap }),
      });
    },
  },
  {
    id: 'plot.structure-momentum',
    sources: ['manuscript', 'reverseOutline', 'reverseOutline.plotlines', 'series.arc.readerMap'],
    label: 'Plot structure & momentum',
    description:
      'LLM scan for the macro pathologies editors flag at the manuscript/arc level: a passive protagonist (events happen TO them), deus ex machina / convenient coincidence, idiot plot (conflict that only persists because characters avoid the obvious), flat or unclear stakes that never escalate, a sagging middle with no try-fail rhythm, and dropped subplots. Reads the stitched manuscript plus the reverse-outline scene map + plotline coverage (reconciling fizzled threads against tagged plotlines) and the authored reader-map hooks/payoffs; degrades to a whole-manuscript scan when no outline exists.',
    scope: 'series',
    kind: 'llm',
    category: 'plot',
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
      // All three blocks are fixed per-call overhead (re-sent on each chunk) and
      // pure context: the scene map lets the model attribute pacing/stakes findings
      // to scenes, the plotline coverage lets it reconcile dropped subplots against
      // the author's tagged threads, and the authored hooks/payoffs ground the
      // stakes/escalation judgment. The check degrades gracefully — no outline ⇒
      // {{#sceneMap}}/{{#plotlineMap}} render nothing; no reader map ⇒ {{#authoredSetups}}
      // renders nothing and the model reasons from the prose alone.
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      const plotlineMap = plotlineCoverageSummary(ctx.reverseOutlinePlotlines, ctx.reverseOutline);
      const authoredSetups = authoredSetupPayoffSummary(ctx.series?.arc?.readerMap);
      return runManuscriptLlmCheck(ctx, {
        stage: PLOT_STRUCTURE_STAGE,
        category: 'plot',
        // sceneMap grows unbounded with scene count; plotlineMap and authoredSetups
        // are bounded — so largest-first trimming absorbs the cut into sceneMap.
        context: { sceneMap, plotlineMap, authoredSetups },
        // `isFinal` gates the whole-corpus judgments — a sagging middle, a never-
        // escalating arc, and a dropped subplot can only be judged once the whole
        // manuscript is in view; an earlier chunk can't know a thread is picked back
        // up (or stakes rise) later, so it would false-flag. A single-chunk run is
        // its own final part and judges the whole text.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          sceneMap: c.sceneMap,
          plotlineMap: c.plotlineMap,
          authoredSetups: c.authoredSetups,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // Plot pathologies span the whole arc — the cross-chunk findings digest keeps
        // prior findings in view so a later chunk doesn't re-flag, and the clean-setup
        // digest rolls forward which subplots/stakes have been opened so a later
        // payoff (or escalation) isn't mis-read as a dropped/flat thread.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus: 'Open plot threads/subplots and whether each has been resolved yet; '
          + 'the stakes established so far and whether they have escalated; and any setup '
          + '(a planted problem, a coincidence, a try-fail attempt) a later part should pay off, '
          + 'so a later chunk can tell a genuinely dropped subplot or flat-stakes arc from one whose payoff simply has not arrived yet.',
      });
    },
  },
  {
    id: 'pacing.escalation-curve',
    sources: ['manuscript', 'reverseOutline'],
    label: 'Pacing — escalation curve',
    description:
      'LLM scan of the SERIES-WIDE escalation curve: it scores each issue\'s dramatic intensity (stakes, conflict, tension) and flags a curve that fails to build — flat intensity (issue 1 reads as intensely as issue N), a front-loaded climax (the biggest reveal / set-piece lands early and the rest coasts), or stakes that plateau or de-escalate across the arc. Reads the stitched manuscript plus the reverse-outline scene map and a deterministic per-issue conflict-marker density tally (a grounding hint the model confirms against the prose); degrades to a whole-manuscript scan when no outline exists. Subsumes "conflict escalation" as one signal of the same curve and complements plot.structure-momentum (which flags flat stakes as one of many macro pathologies) by focusing the lens on the whole-series intensity shape.',
    scope: 'series',
    kind: 'llm',
    category: 'pacing',
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
      // context: the scene map lets the model attribute escalation findings to a
      // scene + issue, and the conflict-marker tally — computed once over the WHOLE
      // manuscript so the curve is complete on every chunk — grounds the per-issue
      // intensity scoring with a deterministic density signal. The check degrades
      // gracefully — no outline ⇒ {{#sceneMap}} renders nothing; no issue headers ⇒
      // {{#intensityTally}} renders nothing and the model scores intensity from the
      // prose alone.
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      const intensityTally = conflictIntensityTally(ctx.manuscript);
      return runManuscriptLlmCheck(ctx, {
        stage: PACING_ESCALATION_STAGE,
        category: 'pacing',
        // sceneMap grows unbounded with scene count; intensityTally is bounded by
        // issue count — so largest-first trimming absorbs the cut into sceneMap.
        context: { sceneMap, intensityTally },
        // `isFinal` gates the whole-curve judgments — a flat curve, a front-loaded
        // climax, and a plateaued/de-escalating arc can only be judged once the
        // whole manuscript is in view; an earlier chunk can't know intensity rises
        // later, so it would false-flag.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          sceneMap: c.sceneMap,
          intensityTally: c.intensityTally,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // Intensity accrues across the whole manuscript — the findings digest keeps
        // prior findings in view so a later chunk doesn't re-flag, and the clean-
        // setup digest rolls forward the per-issue intensity seen so far so a later
        // climax isn't mis-read as a flat or front-loaded curve.
        crossChunkDigest: true,
        crossChunkSetup: true,
        // #1667: this check's whole-curve verdict is gated to the final part AND
        // anchored on the carried per-issue intensity digest — without it the final
        // call would judge only the last chunk plus the crude tally. So the digest
        // must reach the final chunk even when it's packed to the window — reserve
        // room by trimming the final chunk's manuscript tail rather than silently
        // dropping it (mirrors arc.climax-agency / emotion.reaction-proportionality).
        reserveSetupDigest: true,
        setupFocus: 'For each issue/part seen so far, note the level of dramatic intensity '
          + '(stakes, conflict, tension) and whether it has been rising, holding flat, or '
          + 'falling, so a later chunk can judge the WHOLE escalation curve and tell a genuinely '
          + 'flat or front-loaded arc from one whose climax simply has not arrived yet.',
      });
    },
  },
  {
    id: 'emotion.reaction-proportionality',
    sources: ['manuscript', 'reverseOutline'],
    label: 'Emotional beat proportionality (reactions vs event magnitude)',
    description:
      'LLM scan for emotional beats that do not track the magnitude of what happens: a high-magnitude event (trauma, a death, a betrayal, a major loss or win) that draws no on-page reaction and is never processed in later issues (under-reaction), or a minor setback that triggers grief, rage, or despair out of all proportion (over-reaction). Uses the reverse-outline scene map to weigh each event and attribute findings to the right issue; degrades to a whole-manuscript scan when no outline exists. Because an unprocessed event can stay unaddressed many issues later, an event flagged in an early part is carried forward so a later part can flag the missing reaction.',
    scope: 'series',
    kind: 'llm',
    category: 'emotion',
    // Fallback severity when the model omits one — 'medium' to match the sibling
    // characterization/arc LLM checks. The prompt directs the model to mark a major
    // trauma left wholly unprocessed 'high' per finding, so a genuinely jarring
    // emotional gap still surfaces as high.
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
      // The scene map is fixed per-call overhead (re-sent on each chunk) and pure
      // context: it records each scene's events so the model can weigh an event's
      // MAGNITUDE and attribute a finding to the right issue. The check degrades
      // gracefully — no outline ⇒ {{#sceneMap}} renders nothing and the model
      // weighs each event from the prose's own description.
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: REACTION_PROPORTIONALITY_STAGE,
        category: 'emotion',
        context: { sceneMap },
        // `finalPart` gates ONLY the under-reaction verdict. "A high-magnitude
        // event is never processed afterward" is a whole-story claim — a non-final
        // chunk can't know whether a LATER chunk pays the event off, and
        // runChunkedManuscriptCheck merges findings first-wins and never retracts,
        // so an under-reaction reported early would persist even after a later
        // payoff clears it (a false positive). Over-reactions stay local — a
        // disproportionate reaction is fully visible in the chunk that contains it.
        // A single-chunk run is its own final part and judges the whole text.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          sceneMap: c.sceneMap,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // A reaction is proportionate (or not) only relative to the event that
        // triggered it — and the event and its (missing) processing can be issues
        // apart. The findings digest keeps prior findings in view so a later chunk
        // doesn't re-flag the same gap, and the clean-setup digest rolls forward
        // every high-magnitude event that has NOT yet drawn a proportionate
        // reaction so the FINAL chunk can flag the unprocessed trauma even when it
        // happened pages earlier.
        crossChunkDigest: true,
        crossChunkSetup: true,
        // #1667: the under-reaction verdict is gated to the final part AND anchored on
        // the carried unprocessed-event snippet, so guarantee the setup digest reaches
        // the final chunk (trim its manuscript tail to fit) rather than letting a packed
        // final chunk drop the snippet and miss the unprocessed-trauma finding.
        reserveSetupDigest: true,
        setupFocus: 'List the high-magnitude emotional events seen so far (a death, trauma, betrayal, '
          + 'a major loss or hard-won victory) and, for each, whether the affected character has yet shown '
          + 'a proportionate on-page reaction or processed it. CRUCIALLY: carry forward every event that is '
          + 'still AWAITING a proportionate reaction — record which character it befell, which issue it '
          + 'occurred in, a short note on its magnitude, AND a SHORT verbatim snippet (≤ 200 chars) of the '
          + 'event itself — and drop it only once the prose has paid it off with a fitting reaction. The '
          + 'verbatim snippet is required: the final part can only report the under-reaction if it can quote '
          + 'the event as its anchor, and the event text is no longer in view by then. This lets a later '
          + 'part flag (and quote) a trauma that is introduced early and then left unprocessed many issues '
          + 'later.',
      });
    },
  },
  {
    id: 'opening.wrong-start',
    sources: ['manuscript'],
    label: 'Weak opening (wrong place to start)',
    description:
      'LLM scan — flags clichéd or weak story/scene openers: "he wakes up" / alarm-clock / waking-from-a-dream starts, weather/scene-setting preambles, and openings that begin before the interesting moment. A scene should open as late into the action as it can.',
    scope: 'issue',
    kind: 'llm',
    category: 'opening',
    severityDefault: 'medium',
    defaultEnabled: true,
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
    // Localized to chapter/scene openings (one finding per opener), so this stays
    // a plain per-chunk run with no cross-chunk digest — mirrors prose.info-dumping.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: OPENING_START_STAGE,
      category: 'opening',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'endings.cliffhanger',
    sources: ['manuscript', 'series.arc.readerMap'],
    label: 'Chapter-ending cliffhangers (soft landings)',
    description:
      'LLM scan — flags chapter/issue endings that resolve and settle instead of leaving a question open. Every chapter is an episode and should end on an unresolved beat that pulls the reader forward; a "soft landing" that ties everything off mid-story bleeds momentum. Reconciles detected endings against the authored reader-map cliffhangers, and leaves a clearly terminal final-chapter ending alone.',
    scope: 'series',
    kind: 'llm',
    category: 'pacing',
    // A soft landing is advisory by default; the prompt tells the model to return
    // medium when a mid-story chapter fully resolves and settles (mapLlmFindings
    // keeps a valid model severity and only falls back to this default for an
    // invalid/absent one).
    severityDefault: 'low',
    defaultEnabled: true,
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
      // Authored cliffhangers are fixed per-call overhead (re-sent on each chunk).
      const authoredCliffhangers = authoredCliffhangerSummary(ctx.series?.arc?.readerMap);
      return runManuscriptLlmCheck(ctx, {
        stage: ENDINGS_CLIFFHANGER_STAGE,
        category: 'pacing',
        context: { authoredCliffhangers },
        // `finalPart` gates the "leave the terminal chapter alone" exemption (#1298):
        // on a chunked manuscript, only the LAST part can contain the series finale,
        // so an earlier part must NOT treat its last visible chapter as terminal
        // (that would false-negative a soft landing at a chunk boundary). A
        // single-chunk run is its own final part. Mirrors the Chekhov check.
        buildVars: (manuscript, meta, c) => ({ manuscript, authoredCliffhangers: c.authoredCliffhangers, finalPart: meta?.isFinal ? 'true' : '' }),
      });
    },
  },
];
