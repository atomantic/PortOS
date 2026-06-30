// Editorial checks — characterArc group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  ARC_REGRESSION_STAGE,
  ARC_TRANSITIONS_STAGE,
  CHARACTER_CONSISTENCY_STAGE,
  CLIMAX_AGENCY_STAGE,
  EDITORIAL_PROMPT_OVERHEAD_TOKENS,
  INTERIORITY_STAGE,
  SECONDARY_ARC_STAGE,
  authoredPayoffsSummary,
  canonCharacterTraitsSummary,
  canonRosterNamesSummary,
  declaredThemesSummary,
  eachRelationshipLink,
  relationshipCanon,
  renderCharacterArcsForPrompt,
  runManuscriptLlmCheck,
  sceneGroundingSummary,
  secondaryCharacterPresenceSummary,
  z,
} from '../checkInfra.js';

export const characterArcChecks = [
  {
    id: 'character.consistency',
    sources: ['manuscript', 'canon', 'reverseOutline', 'series.characterArcs'],
    label: 'Character consistency (unearned personality shift)',
    description:
      'LLM scan for UNEARNED characterization changes: a reserved character who suddenly cracks jokes with no arc beat, an established trait silently contradicted (a stated fear, allergy, or skill the prose breaks), or POV-character knowledge that changes mid-scene without on-page learning. Reconciles the prose against the established canon character traits (personality, fixed traits, mannerisms, speech), the reverse-outline scene ordering, and the AUTHORED per-character arcs — so an intentional, earned transition is NOT flagged. Degrades to a prose-only scan when no canon or outline exists.',
    scope: 'series',
    kind: 'llm',
    category: 'character',
    // Fallback severity when the model omits one — 'medium' to match the sibling
    // characterization/continuity LLM checks. The prompt directs the model to mark
    // a flat trait-contradiction that breaks a plot beat 'high' per finding, so a
    // genuinely-jarring shift still surfaces as high.
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
      // pure context: the canon traits give the established temperament/voice/
      // fixed-trait baseline a shift must be measured against, the scene map gives
      // the chronology to spot a knowledge-jump within a scene, and the authored
      // arcs let the model SUPPRESS an earned transition (a character the author
      // intends to change). The check degrades gracefully — no canon ⇒
      // {{#canonTraits}} renders nothing; no outline ⇒ {{#sceneMap}} renders
      // nothing; no authored arcs ⇒ {{#characterArcs}} renders nothing and the
      // model reasons from the prose's own internal consistency.
      const canonTraits = canonCharacterTraitsSummary(ctx.canon);
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      const characterArcs = renderCharacterArcsForPrompt(ctx.series?.characterArcs) || '';
      return runManuscriptLlmCheck(ctx, {
        stage: CHARACTER_CONSISTENCY_STAGE,
        category: 'character',
        // canonTraits + sceneMap grow with cast/scene count; characterArcs is
        // bounded — so largest-first trimming absorbs the cut into those.
        context: { canonTraits, sceneMap, characterArcs },
        buildVars: (manuscript, _meta, c) => ({
          manuscript,
          canonTraits: c.canonTraits,
          sceneMap: c.sceneMap,
          characterArcs: c.characterArcs,
        }),
        // A personality shift is only visible against what came BEFORE — the
        // reserved-character baseline lives in an early chunk and the unearned
        // joke lands in a later one. The findings digest keeps prior findings in
        // view so a later chunk doesn't re-flag, and the clean-setup digest rolls
        // each character's established temperament forward so a later chunk can
        // catch a trait that silently flips.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus:
          'For each named character, note their established temperament, voice, and fixed traits (how they speak, what they fear/avoid, what they know) plus any EARNED change the prose has already paid off. Carry these forward so a later chunk can tell an unearned shift (a reserved character suddenly joking, a stated fear ignored, knowledge appearing with no on-page learning) from a transition the story has legitimately set up.',
      });
    },
  },
  {
    id: 'character.secondary-arc',
    sources: ['manuscript', 'reverseOutline', 'canon'],
    label: 'Secondary-character arcs (recurring non-POV cast)',
    description:
      'LLM scan — the non-POV sibling of pov.justified (#1295). Tallies recurring NON-POV characters from the reverse-outline scene map (present in multiple scenes but never holding the viewpoint) and judges whether each shows meaningful change across the story: a flat side character who is the same at the end as at the start, or one who regresses with no purpose. A world of flat side characters drains a story\'s texture. Does NOT flag a genuine walk-on (a one-scene minor) or a deliberately-static figure whose constancy is the point (an anchor/foil the protagonist changes against); judges only the recurring cast. Because a flat arc is a whole-story claim, the verdict lands on the final manuscript part once every scene is in view; degrades to a whole-manuscript scan when no outline exists.',
    scope: 'series',
    kind: 'llm',
    category: 'arc',
    // Fallback severity when the model omits one — 'low' to match pov.justified
    // (a secondary-cast arc gap is a texture concern, not a structural break). The
    // prompt directs the model to mark a prominent recurring character left wholly
    // flat 'medium', so a genuinely-thin co-lead still surfaces above the floor.
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // A non-POV character must appear in at least this many scenes to count as
      // recurring (and therefore be held to an arc). 1 would judge every walk-on;
      // 2 is the smallest "recurring" threshold.
      minScenes: z.number().int().min(2).max(20).default(2),
      // Cap findings per run so a large cast can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'minScenes',
        label: 'Recurring threshold (min scenes)',
        type: 'number',
        min: 2,
        max: 20,
        step: 1,
        help: 'A non-POV character must appear in at least this many scenes to be judged for an arc. 2 is the smallest "recurring" threshold; raise it to focus on only the most prominent secondary characters.',
      },
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a large cast can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // All three blocks are fixed per-call overhead (re-sent on each chunk) and
      // pure context: the secondary-cast roster names which recurring non-POV
      // characters to hold to an arc (so the model focuses on the side characters
      // that carry weight, not every walk-on); the canon names roster lets the
      // model tell a MODELED recurring character from an incidental name (it lists
      // every named bible character, including trait-less ones — so it stays
      // useful where the richer traits block is empty); and the canon traits give
      // the established baseline a change must be measured against. The check
      // degrades gracefully — no outline ⇒ {{#secondaryCast}} renders nothing and
      // the model identifies the recurring side cast from the prose; no canon ⇒
      // {{#canonRoster}} / {{#canonTraits}} render nothing.
      const minScenes = ctx.config?.minScenes ?? 2;
      const secondaryCast = secondaryCharacterPresenceSummary(ctx.reverseOutline, { minScenes });
      const canonRoster = canonRosterNamesSummary(ctx.canon);
      const canonTraits = canonCharacterTraitsSummary(ctx.canon);
      return runManuscriptLlmCheck(ctx, {
        stage: SECONDARY_ARC_STAGE,
        category: 'arc',
        context: { secondaryCast, canonRoster, canonTraits },
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          secondaryCast: c.secondaryCast,
          canonRoster: c.canonRoster,
          canonTraits: c.canonTraits,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // A flat arc is only visible across the WHOLE story — a character
        // established in an early chunk who never changes by the last. The
        // findings digest keeps prior findings in view so a later chunk doesn't
        // re-flag, and the clean-setup digest rolls each recurring secondary
        // character's established state forward so the final part can tell a flat
        // arc from one that changes in a chunk it can no longer see.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus: 'For each recurring NON-POV character (a character present across multiple scenes who never '
          + 'holds the viewpoint), note their established state on first appearance — their situation, attitude, '
          + 'wants, and standing — and record any CHANGE the prose has shown them undergo since (a decision, a '
          + 'shift in attitude or circumstance, a relationship that turns). Carry these forward so the final part '
          + 'can tell a genuinely flat side character (same at the end as the start) from one whose change happened '
          + 'in an earlier part no longer in view. Drop a character from the watch-list once the prose has shown '
          + 'them a meaningful arc.',
      });
    },
  },
  {
    id: 'arc.transitions',
    sources: ['manuscript', 'reverseOutline', 'series.characterArcs'],
    label: 'Character-arc transitions (change moments + flat arcs)',
    description:
      'Scans each character\'s scenes for genuine change moments — a decision, a realization, a point of no return, a relapse, a sacrifice — and proposes transition beats with anchor quotes. Reconciles detected change moments against the AUTHORED per-character arcs (series.characterArcs): flags a transition the prose delivers but the arc never recorded, an authored transition the prose never pays off, and a character who carries the story but has no transition scenes at all (a flat arc).',
    scope: 'series',
    kind: 'llm',
    category: 'arc',
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
      // context: the scene map lets the model attribute transitions to scenes,
      // the authored arcs let it reconcile detected vs authored change moments.
      // The check degrades gracefully — no outline ⇒ {{#sceneMap}} renders
      // nothing; no authored arcs ⇒ {{#characterArcs}} renders nothing and the
      // check proposes transitions from scratch (and can't fire the
      // "missing/unjustified authored transition" reconciliation arm).
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      const characterArcs = renderCharacterArcsForPrompt(ctx.series?.characterArcs) || '';
      return runManuscriptLlmCheck(ctx, {
        stage: ARC_TRANSITIONS_STAGE,
        category: 'arc',
        context: { sceneMap, characterArcs },
        buildVars: (manuscript, _meta, c) => ({ manuscript, sceneMap: c.sceneMap, characterArcs: c.characterArcs }),
        // Arc change moments accrue across the whole manuscript — a flat-arc
        // verdict needs to see whether a character ever changed in a LATER
        // chunk. Roll a "transitions seen so far" digest forward so a
        // multi-chunk manuscript doesn't false-flag an early-chapters-flat
        // character whose turn lands in the finale.
        crossChunkSetup: true,
        setupFocus:
          'For each named character, note any genuine change moment so far (a decision, realization, point of no return, relapse, or sacrifice) and where it landed. Carry forward who has changed and who is still flat, so a later chunk can tell a truly flat arc from one whose turn simply has not arrived yet.',
      });
    },
  },
  {
    id: 'arc.regression',
    sources: ['manuscript', 'reverseOutline', 'series.characterArcs'],
    label: 'Character-arc regression / premature closure',
    description:
      'LLM scan of the SHAPE of each character\'s progress across the whole series — not the change moments themselves (that is arc.transitions) but whether the arc holds together end to end. Flags an unmotivated REGRESSION (a character grows, then reverts to their old self with no purpose or earned reason — distinct from a deliberate, dramatized relapse), a CIRCULAR arc (the character ends in the same state they began, the growth cancelled out with nothing gained), and PREMATURE CLOSURE (the arc fully resolves early — e.g. issue 3 of 10 — and the character is flat for the rest of the series, deflating the back half). Reads the stitched manuscript plus the reverse-outline scene map and the AUTHORED per-character arcs (series.characterArcs) to reconcile the planned end-state against what the prose delivers; degrades to a whole-manuscript scan when no outline or authored arcs exist. Whole-arc verdicts are gated to the final manuscript part so a mid-arc character whose later growth is still ahead is not false-flagged.',
    scope: 'series',
    kind: 'llm',
    category: 'arc',
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
      // context: the authored arcs name each character's planned start → end state
      // so the model can tell a regression/circular arc from the intended ending,
      // and the scene map lets it attribute a finding to a scene + issue. The check
      // degrades gracefully — no authored arcs ⇒ {{#characterArcs}} renders nothing
      // and the model judges the arc shape from the prose alone; no outline ⇒
      // {{#sceneMap}} renders nothing.
      const characterArcs = renderCharacterArcsForPrompt(ctx.series?.characterArcs) || '';
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: ARC_REGRESSION_STAGE,
        category: 'arc',
        // sceneMap grows unbounded with scene count; characterArcs is bounded by the
        // roster — so largest-first trimming absorbs the cut into sceneMap.
        context: { characterArcs, sceneMap },
        // `isFinal` gates the whole-arc verdicts — regression, a circular arc, and
        // premature closure can only be judged once the WHOLE arc is in view. An
        // earlier chunk can't know a reverted character grows back, an apparent
        // circle re-opens, or a "resolved" arc keeps developing — so it would
        // false-flag. A single-chunk run is its own final part and judges the whole
        // text.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          characterArcs: c.characterArcs,
          sceneMap: c.sceneMap,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // Each character's progress accrues across the whole manuscript — the
        // findings digest keeps prior findings in view so a non-final chunk doesn't
        // pre-flag, and the clean-setup digest rolls forward each character's
        // start-state, peak growth, and latest state so the final chunk can detect a
        // revert, a closed circle, or an arc that resolved early and went flat.
        crossChunkDigest: true,
        crossChunkSetup: true,
        // #1667: this check's verdict is gated to the final part AND anchored on the
        // carried per-character progress digest — without it the final call would
        // judge only the last chunk plus a summary and could not tell whether a
        // character's growth peaked then reverted earlier. So the digest must reach
        // the final chunk even when it's packed to the window — reserve room by
        // trimming the final chunk's manuscript tail rather than silently dropping it
        // (mirrors arc.climax-agency / pacing.escalation-curve).
        //
        // Tradeoff (the reserve only bites when the manuscript spans many chunks AND
        // the final chunk is packed to within the digest's size of the window — a
        // single-chunk run, the common provider-fits-the-book case, has no digest and
        // keeps the whole ending): trimming the final chunk's tail can clip the very
        // end-state this check reads for a circular arc or a late regression. Reserve
        // is still the right call because the START state and any EARLY resolution —
        // the anchors a circular-arc / premature-closure verdict cannot be made
        // without — live ONLY in the digest, while the ending is still mostly covered
        // by the final chunk's HEAD plus the carried "latest state" the setupFocus
        // rolls forward. Dropping the digest would keep the last few hundred chars of
        // ending but lose the beginning, which is the worse failure for an arc-SHAPE
        // judgment. The setupFocus below carries each character's start/peak/latest so
        // the lag is one chunk, not the whole history.
        reserveSetupDigest: true,
        setupFocus: 'For each named character who carries an arc, track their progress so far as a '
          + 'short trajectory: their START state, the PEAK of their growth (the most-changed point '
          + 'reached and which issue it landed in), and their LATEST state. Note when a character '
          + 'who had grown reverts toward their old self (a possible regression — record whether the '
          + 'revert is dramatized/earned or unmotivated), and when a character\'s arc appears fully '
          + 'RESOLVED (their want/need settled) and which issue it resolved in, so a later part can '
          + 'tell a genuinely premature closure (resolved early then flat) or a circular arc (ended '
          + 'where it began) from an arc whose further development simply has not arrived yet.',
      });
    },
  },
  {
    id: 'arc.climax-agency',
    sources: ['manuscript', 'reverseOutline', 'series.arc.readerMap', 'series.arc.themes'],
    label: 'Climax / resolution power (passive protagonist at the climax)',
    description:
      'LLM scan for a weak climax: the story\'s payoff scene should be the protagonist\'s HARDEST, most ACTIVE choice — the moment they drive the resolution. Flags a passive climax (an ally rescues them, the antagonist self-destructs, a coincidence resolves it, or events simply happen TO the protagonist) and a climax that resolves the PLOT but not the emotional/thematic core the story set up. Reconciles the prose against the authored reader-map payoffs (what the reader was promised) and the declared themes, using the reverse-outline scene map to locate the climax; degrades to a whole-manuscript scan when no reader-map, themes, or outline exists. Complements plot.structure-momentum (passive protagonist arc-wide) by focusing the lens on the single climax scene.',
    scope: 'series',
    kind: 'llm',
    category: 'arc',
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
      // pure context: the authored payoffs name what the reader was PROMISED the
      // climax would resolve, the declared themes name the thematic core the
      // resolution must land, and the scene map lets the model LOCATE the climax
      // scene and attribute the finding to its issue. The check degrades
      // gracefully — no reader map ⇒ {{#authoredPayoffs}} renders nothing; no
      // themes ⇒ {{#declaredThemes}} renders nothing; no outline ⇒ {{#sceneMap}}
      // renders nothing and the model reasons from the prose's own shape.
      const authoredPayoffs = authoredPayoffsSummary(ctx.series?.arc?.readerMap);
      const declaredThemes = declaredThemesSummary(ctx.series?.arc?.themes);
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      return runManuscriptLlmCheck(ctx, {
        stage: CLIMAX_AGENCY_STAGE,
        category: 'arc',
        // sceneMap grows unbounded with scene count; authoredPayoffs and
        // declaredThemes are bounded — so largest-first trimming absorbs the cut
        // into sceneMap.
        context: { authoredPayoffs, declaredThemes, sceneMap },
        // `isFinal` gates the verdict — the climax is the END of the arc, so it
        // can only be identified and judged once the whole manuscript is in view.
        // An earlier chunk can't know which scene is the climax (or whether a
        // later beat is the real payoff), so it would false-flag. A single-chunk
        // run is its own final part and judges the whole text.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          authoredPayoffs: c.authoredPayoffs,
          declaredThemes: c.declaredThemes,
          sceneMap: c.sceneMap,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // The climax's agency is judged against the whole arc's setup — the
        // protagonist's tries/failures and the problem they must personally
        // resolve accrue across the manuscript. The findings digest keeps prior
        // findings in view so a non-final chunk doesn't pre-flag, and the
        // clean-setup digest rolls forward the central problem + the protagonist's
        // pattern of agency so the final chunk can judge whether the climax is
        // their hardest active choice.
        crossChunkDigest: true,
        crossChunkSetup: true,
        // #1667: this check's verdict is gated to the final part AND anchored on the
        // carried CLIMAX CANDIDATE snippet, so the setup digest must reach the final
        // chunk even when it's packed to the window — reserve room for it by trimming
        // the final chunk's manuscript tail rather than silently dropping the snippet.
        reserveSetupDigest: true,
        // The setup digest is a separate rolling-summary call (buildSetupDigestPrompt)
        // whose output is fed into the FINAL chunk's prompt. The climax can land in a
        // non-final chunk (followed by a denouement chunk), so the digest must carry
        // the climax CANDIDATE forward — including a short verbatim snippet and who
        // resolves it — or the final chunk would have only tail text + a summary and
        // could neither judge nor quote the climax. This is what lets the final-part
        // verdict stay accurate even when the climax is not physically in the last
        // chunk (closing the false-negative the strict non-final gate would otherwise
        // introduce).
        setupFocus: 'Note the central problem/conflict the protagonist must personally resolve, '
          + 'the thematic question the story is asking, and the protagonist\'s pattern of agency so far '
          + '(do they drive events or do events happen to them). CRUCIALLY: track the single most '
          + 'decisive turning/resolution scene seen so far as the CLIMAX CANDIDATE — record a SHORT '
          + 'verbatim snippet (≤ 200 chars) of its decisive moment, which issue it is in, WHO drives the '
          + 'resolution (the protagonist through a hard choice, or an ally/coincidence/the antagonist '
          + 'self-destructing), and which core problem/theme it resolves — and REPLACE it only when a '
          + 'later, higher-stakes resolution scene supersedes it. This lets the final part judge the '
          + 'climax\'s agency + resolution power and quote it even if the climax is not physically in the '
          + 'last chunk.',
      });
    },
  },
  {
    id: 'relationships.opposition-reversal',
    sources: ['canon'],
    label: 'Opposition role-reversal payoff',
    description:
      'Advisory — surfaces every tagged opposing-force pair (hunter/prey, winner/loser…) so you can confirm whether the reader ever sees the roles reverse, or deliberately not.',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: false,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      const findings = [];
      // Dedupe by the unordered character pair + axis so a reciprocally-tagged
      // opposition (A→B and B→A on the SAME axis) surfaces once — but two
      // DIFFERENT axes on the same pair (hunter/prey AND winner/loser) each
      // surface, since they're distinct payoffs the reader tracks separately.
      const seenPairs = new Set();
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        if (!link.opposition?.axis || !nameById.has(targetId)) continue;
        const pairKey = `${[c.id, targetId].sort().join('|')}|${link.opposition.axis}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const aName = nameById.get(c.id);
        const bName = nameById.get(targetId);
        const { axis, thisRole, targetRole } = link.opposition;
        const roles = thisRole && targetRole ? ` (${aName}: ${thisRole}, ${bName}: ${targetRole})` : '';
        findings.push({
          severity: ctx.severityDefault,
          category: 'arc',
          location: `Characters: ${aName} / ${bName}`,
          problem: `Opposing-force pair tagged on "${aName}" / "${bName}" — axis "${axis}"${roles}.`,
          suggestion: 'Confirm the reader sees these roles reverse at some point in the arc (or that holding them fixed is the intended payoff).',
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'arc.ticking-clock-hygiene',
    sources: ['series.arc.tickingClock'],
    label: 'Ticking-clock hygiene',
    description:
      'Advisory — checks the series ticking clock/countdown is fully specified: named, with stakes, a plant→due span, and reminder beats so the reader does not forget it through the long middle.',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // How many reminder beats an enabled clock should carry. 0 disables the
      // reminder-count check while keeping the named/stakes/span checks.
      minReminders: z.number().int().min(0).max(20).default(1),
    }),
    configFields: [
      {
        key: 'minReminders',
        label: 'Minimum reminder beats',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        help: 'How many reminder beats an enabled ticking clock should have so the reader does not forget it through the long middle.',
      },
    ],
    // Only audit a clock the author turned on — a disabled/absent clock means
    // "this story has no countdown", which is a valid choice, not a problem.
    gate: (ctx) => ctx.series?.arc?.tickingClock?.enabled === true,
    run: (ctx) => {
      const clock = ctx.series?.arc?.tickingClock;
      if (!clock || clock.enabled !== true) return [];
      const minReminders = ctx.config?.minReminders ?? 1;
      const label = clock.label || 'the ticking clock';
      const location = `Series arc: ${clock.label || 'ticking clock'}`;
      const findings = [];
      const flag = (problem, suggestion) => findings.push({
        severity: ctx.severityDefault,
        category: 'arc',
        location,
        problem,
        suggestion,
        anchorQuote: clock.label || '',
        issueNumber: null,
      });
      if (!clock.label) {
        flag(
          'The ticking clock is enabled but unnamed — the reader needs a concrete thing to count down to.',
          'Give the countdown a specific label (e.g. "The storm makes landfall").',
        );
      }
      if (!clock.stakes) {
        flag(
          `The ticking clock "${label}" has no stakes — it is unclear what the reader fears if it runs out.`,
          'State what happens when the clock hits zero so the countdown carries dread.',
        );
      }
      if (clock.plantedAtArcPosition == null) {
        flag(
          `The ticking clock "${label}" has no plant position — the reader never learns the countdown has started.`,
          'Set where the reader first learns of the countdown (plantedAtArcPosition).',
        );
      }
      if (clock.dueAtArcPosition == null) {
        flag(
          `The ticking clock "${label}" has no due position — there is no moment it lands.`,
          'Set where the countdown pays off (dueAtArcPosition).',
        );
      }
      // Plant and due share the arc-position coordinate space, so they're
      // directly comparable; a due at/before the plant leaves no span for
      // tension to build. (Reminders use issue numbers, a different axis, so
      // they're intentionally NOT compared against the plant/due span here.)
      if (
        clock.plantedAtArcPosition != null
        && clock.dueAtArcPosition != null
        && clock.dueAtArcPosition <= clock.plantedAtArcPosition
      ) {
        flag(
          `The ticking clock "${label}" is due (arc position ${clock.dueAtArcPosition}) at or before it is planted (${clock.plantedAtArcPosition}) — there is no span for tension to build.`,
          'Set the due position after the plant position.',
        );
      }
      const reminders = Array.isArray(clock.reminders) ? clock.reminders : [];
      if (reminders.length < minReminders) {
        flag(
          `The ticking clock "${label}" has ${reminders.length} reminder beat(s) (expected at least ${minReminders}) — without periodic reminders the reader forgets it through the long middle.`,
          'Add reminder beats between the plant and due to keep the countdown alive in the reader’s mind.',
        );
      }
      return findings;
    },
  },
  {
    id: 'interiority.protagonist',
    sources: ['manuscript'],
    label: 'Protagonist interiority (mind / objective / emotion / decision)',
    description:
      'Flags POV scenes that move a viewpoint character through events without developing their interiority — their thoughts and feelings, what they want and why, their emotional response to twists, and the reasoning behind their decisions. Infers POV from the prose when it is not explicitly tagged.',
    scope: 'issue',
    kind: 'llm',
    category: 'character',
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
    // Per-scene, localized findings (one interiority gap = one scene), so this
    // stays a plain per-chunk run with no cross-chunk digest — mirrors
    // prose.info-dumping.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: INTERIORITY_STAGE,
      category: 'character',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
];
