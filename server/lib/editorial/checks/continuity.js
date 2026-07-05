// Editorial checks — continuity group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  CHEKHOV_STAGE,
  OBJECT_BACKSTORY_STAGE,
  OBJECT_MOTIVATION_STAGE,
  OBJECT_WEIGHT_STAGE,
  TIMELINE_CONTRADICTION_STAGE,
  attachmentBackstoryRows,
  attachmentCanon,
  authoredSetupPayoffSummary,
  canonCharacterStatesSummary,
  continuityLedgerSummary,
  describeObjectAttachments,
  describeObjectWeight,
  eachRelationshipLink,
  mapLlmFindings,
  relationshipCanon,
  renderCharacterArcsForPrompt,
  runManuscriptLlmCheck,
  sceneGroundingSummary,
  z,
} from '../checkInfra.js';

export const continuityChecks = [
  {
    id: 'continuity.timeline-contradiction',
    sources: ['manuscript', 'canon', 'continuityBible', 'reverseOutline', 'series.characterArcs'],
    label: 'Timeline / canon contradiction',
    description:
      'LLM scan for internal contradictions against canon and chronology: a character who dies and later reappears alive without explanation, an age contradiction (the bible says 16, the prose says "in her 30s"), or an impossible timeline (an event dated day 2 that characters needed 8 days to reach). Reconciles the prose against the continuity-bible facts ledger (ages, dates & elapsed time, locations, world rules), the canon character facts, the reverse-outline scene ordering, and the authored per-character arc start/end states; degrades to a prose-only scan when none of those exist.',
    scope: 'series',
    kind: 'llm',
    category: 'continuity',
    // Fallback severity when the model omits one — kept 'medium' to match the
    // sibling continuity/narrative LLM checks. The prompt directs the model to
    // mark a plot-breaking resurrection or impossible timeline 'high' per finding,
    // so genuinely-fatal contradictions still surface as high.
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
      // All four blocks are fixed per-call overhead (re-sent on each chunk) and
      // pure context: the continuity-bible ledger is the authoritative fact set
      // (ages, dates/elapsed time, locations, world rules) the contradiction is
      // judged against, the canon facts add per-character age/status/identity, the
      // scene map gives the chronology to catch impossible timelines and
      // resurrection-without-explanation, and the authored arcs give each
      // character's intended start → end state. The check degrades gracefully — an
      // absent input renders nothing (`{{#continuityLedger}}`/`{{#canonStates}}`/
      // `{{#sceneMap}}`/`{{#characterArcs}}`) and the model reasons from the prose.
      const continuityLedger = continuityLedgerSummary(ctx.continuityBible);
      const canonStates = canonCharacterStatesSummary(ctx.canon);
      const sceneMap = sceneGroundingSummary(ctx.reverseOutline);
      const characterArcs = renderCharacterArcsForPrompt(ctx.series?.characterArcs) || '';
      return runManuscriptLlmCheck(ctx, {
        stage: TIMELINE_CONTRADICTION_STAGE,
        category: 'continuity',
        // continuityLedger + canonStates + sceneMap grow with fact/cast/scene
        // count; characterArcs is bounded — so largest-first trimming absorbs the
        // cut into those.
        context: { continuityLedger, canonStates, sceneMap, characterArcs },
        buildVars: (manuscript, _meta, c) => ({
          manuscript,
          continuityLedger: c.continuityLedger,
          canonStates: c.canonStates,
          sceneMap: c.sceneMap,
          characterArcs: c.characterArcs,
        }),
        // A contradiction spans the manuscript — a death in an early chunk and a
        // resurrection in a later one are only visible together. The findings
        // digest keeps prior findings in view so a later chunk doesn't re-flag,
        // and the clean-setup digest rolls each character's last-known state
        // forward so a later chunk can catch a state that silently flips.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus:
          'For each named character, note their last-established state a later part must stay consistent with: alive or dead (and how/when), stated or implied age, and current location — plus any dated events and the elapsed time between them. Carry these forward so a later chunk can catch a character who reappears alive after dying, an age that contradicts an earlier one, or an impossible chronology.',
      });
    },
  },
  {
    id: 'relationships.reciprocity',
    sources: ['canon'],
    label: 'Relationship reciprocity',
    description:
      'Flags one-sided structured relationship links — character A links to B, but B has no link back to A.',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      // For O(1) "does B link back to A?" lookups, index every link as a
      // "<source>→<target>" pair key.
      const linkPairs = new Set();
      for (const { c, targetId } of eachRelationshipLink(chars)) linkPairs.add(`${c.id}→${targetId}`);
      const findings = [];
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        // A dangling target (B doesn't exist) is the dangling-target check's
        // job; reciprocity only speaks to links between two real characters.
        if (!nameById.has(targetId)) continue;
        if (linkPairs.has(`${targetId}→${c.id}`)) continue;
        const aName = nameById.get(c.id);
        const bName = nameById.get(targetId);
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Characters: ${aName} → ${bName}`,
          problem: `"${aName}" has a ${link.type || 'custom'} link to "${bName}", but "${bName}" has no link back to "${aName}".`,
          suggestion: `Add a reciprocal relationship link from "${bName}" to "${aName}" (or remove the one-sided link if it's intentional).`,
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'relationships.dangling-target',
    sources: ['canon'],
    label: 'Relationship dangling target',
    description:
      'Flags structured relationship links that point at a character id no longer present in the canon (deleted or renamed away).',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      const findings = [];
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        if (nameById.has(targetId)) continue;
        const aName = nameById.get(c.id);
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Character: ${aName}`,
          problem: `"${aName}" has a ${link.type || 'custom'} relationship link pointing at a character id (${targetId}) that no longer exists in the canon.`,
          suggestion: 'Re-point the link at an existing character, or delete the stale link.',
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'objects.unattached-significant',
    sources: ['canon'],
    label: 'Unattached significant object',
    description:
      'Flags objects with written significance but no character attachment — the object clearly matters to the story, yet nobody in the cast is on record caring about it.',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { objects, nameById } = attachmentCanon(ctx);
      const findings = [];
      for (const o of objects) {
        // Only a LIVE attachment (one whose characterId still resolves to a
        // cast member) counts as "someone cares" — an object whose sole
        // attachment dangles at a deleted character is effectively unattached
        // (the UI shows it as "(missing)"), so it should still be flagged.
        const attachments = Array.isArray(o.attachments) ? o.attachments : [];
        const hasLiveAttachment = attachments.some((a) => a?.characterId && nameById.has(a.characterId));
        const significance = (o.significance || '').trim();
        if (hasLiveAttachment || !significance) continue;
        const name = o.name || o.id;
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Object: ${name}`,
          problem: `"${name}" has written significance but no character is attached to it — what does this object mean to anyone in the cast?`,
          suggestion: 'Add an attachment linking this object to the character whose backstory or emotional stake it carries (or clear its significance if it is purely set dressing).',
          anchorQuote: name,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'objects.unmotivated-interaction',
    sources: ['manuscript', 'canon'],
    label: 'Unmotivated object interaction',
    description:
      'LLM scan — flags moments where a character interacts meaningfully with an object the prose (and the canon attachments) have given them no reason to care about.',
    scope: 'issue',
    kind: 'llm',
    category: 'continuity',
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
      const objects = describeObjectAttachments(ctx);
      return runManuscriptLlmCheck(ctx, {
        stage: OBJECT_MOTIVATION_STAGE,
        category: 'continuity',
        // The objects-attachment summary is re-sent per chunk — trimmed to keep the
        // manuscript a budget floor on a small window.
        context: { objects },
        buildVars: (manuscript, _meta, c) => ({ manuscript, objects: c.objects }),
        // An object's motivation can be set up in an earlier chapter and paid off
        // later; without the digest a later chunk may flag a "missing setup" an
        // earlier chunk already accounted for (#1383).
        crossChunkDigest: true,
        // …and a CLEANLY established motivation produces no finding, so the findings
        // digest alone can't carry it forward — roll a setup summary of the objects
        // and their established significance so a later payoff isn't mis-flagged (#1403).
        crossChunkSetup: true,
        setupFocus: 'Objects/items characters interact with, and any motivation, emotional significance, '
          + 'or backstory the prose or canon has established for that object (so a later payoff is recognized as motivated).',
      });
    },
  },
  {
    id: 'objects.backstory-consistency',
    sources: ['canon'],
    label: 'Attachment backstory consistency',
    description:
      "LLM check — flags object attachments whose origin story contradicts the attached character's established background.",
    scope: 'noun',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    // Canon-only (no manuscript): compares each attachment's `origin` against the
    // attached character's `background`, both of which live on the canon.
    configSchema: z.object({
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
        help: 'Cap findings so a large cast can not flood the review.',
      },
    ],
    // Skip the LLM call entirely when no attachment has both an origin AND an
    // attached character with a background to contradict.
    gate: (ctx) => attachmentBackstoryRows(ctx).length > 0,
    run: async (ctx) => {
      const rows = attachmentBackstoryRows(ctx);
      if (!rows.length) return [];
      const attachments = rows.map((r, i) =>
        `${i + 1}. Object "${r.object}" — ${r.character}'s attachment${r.emotion ? ` (${r.emotion})` : ''}\n`
        + `   Origin (how ${r.character} came to have it): ${r.origin}\n`
        + `   ${r.character}'s established background: ${r.background}`,
      ).join('\n\n');
      const { content } = await ctx.callStagedLLM(
        OBJECT_BACKSTORY_STAGE,
        { attachments },
        { returnsJson: true, source: OBJECT_BACKSTORY_STAGE },
      );
      return mapLlmFindings(content?.findings, {
        severityDefault: ctx.severityDefault,
        category: 'continuity',
        max: ctx.config?.maxFindings ?? 12,
        withIssueNumber: false,
      });
    },
  },
  {
    id: 'objects.weight-proportionality',
    sources: ['manuscript', 'canon'],
    label: 'Object narrative-weight proportionality',
    description:
      'LLM check — flags objects whose narrative weight is disproportionate to their prominence: a minor item the prose barely uses yet given a heavy backstory or significance ("a one-line locket with a three-issue origin"), or a climactic / decisive object with little or no established lineage to earn its weight ("an heirloom that resolves the finale, never set up"). Weighs each object\'s prominence in the manuscript against the depth of backstory and payoff established for it — the canon\'s recorded significance/attachments plus what the prose itself plants and pays off. Distinct from objects.unattached-significant (presence of an attachment), objects.unmotivated-interaction (a single unmotivated beat), and objects.backstory-consistency (an origin that contradicts a character\'s background) — the gap here is the over- or under-writing of plot machinery.',
    scope: 'series',
    kind: 'llm',
    category: 'plot',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a large object roster can't flood the review.
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
        help: 'Cap findings so a large object roster can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // The per-object weight summary (prose significance + every attachment's
      // emotion / per-bond significance / origin lineage / role) is fixed per-call
      // overhead re-sent on each chunk — trimmed by the runner to keep the
      // manuscript a budget floor. It surfaces the FULL recorded backstory an
      // object carries (the origin/role fields the leaner attachments summary
      // omits) so the model can weigh that against the object's prose prominence.
      const objects = describeObjectWeight(ctx);
      return runManuscriptLlmCheck(ctx, {
        stage: OBJECT_WEIGHT_STAGE,
        category: 'plot',
        context: { objects },
        // `finalPart` gates the whole-corpus verdict. Both directions of this check
        // are whole-story claims: "over-weighted" needs the object's TOTAL prominence
        // (a non-final chunk can't know a barely-used object pays off later), and
        // "under-established" needs the object's TOTAL lineage (the backstory may sit
        // in an earlier chunk, carried in the setup digest). runChunkedManuscriptCheck
        // merges findings first-wins and never retracts, so an imbalance reported from
        // a non-final chunk would persist even after a later chunk clears it — so a
        // non-final chunk only carries setup forward and the verdict waits for the
        // final part. A single-chunk run is its own final part and judges the whole text.
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          objects: c.objects,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // An object's backstory can be planted in an early chapter and its
        // prominence (or payoff) land much later; the findings digest stops a
        // later chunk re-flagging the same imbalance the prose only half-shows.
        crossChunkDigest: true,
        // …and a cleanly proportioned object produces no finding, so the findings
        // digest alone can't carry it forward — roll a setup summary of each
        // object and the backstory/significance the prose has established so the
        // final part weighs a payoff against the full lineage, not just its chunk.
        crossChunkSetup: true,
        // #1667: the verdict is gated to the final part and weighs each object against
        // its carried prominence/lineage snapshot, so guarantee the setup digest reaches
        // the final chunk (trim its manuscript tail to fit) rather than letting a packed
        // final chunk drop the snapshot and judge an object on its last chunk alone.
        reserveSetupDigest: true,
        setupFocus: 'List the objects/items the story features and, for each, how prominent or decisive it has '
          + 'been so far and the depth of backstory, lineage, or significance the prose or canon has established '
          + 'for it. CRUCIALLY, because the weight verdict is deferred to the final part and the earlier text is '
          + 'no longer in view by then: for every object record which issue(s) it appears in AND a SHORT verbatim '
          + 'snippet (≤ 200 chars) of its most weight-bearing moment (a heavy backstory beat, or a prominent / '
          + 'climactic use) — the snippet is required so the final part can quote it as the finding anchor. This '
          + 'lets the final part weigh a payoff against the full established weight, and still attribute and quote '
          + 'an imbalance whose evidence sits pages earlier, not just in the current part.',
      });
    },
  },
  {
    id: 'chekhov.setups-payoffs',
    sources: ['manuscript', 'series.arc.readerMap', 'series.arc.foreshadowing'],
    label: "Chekhov's guns (setups & payoffs)",
    description:
      'Classifies each setup/payoff thread as paired, false-setup (planted, never fired — cut it), orphaned-payoff (fired, never planted — unearned), or distant (paid off so many issues after the setup the reader may have forgotten). Reconciles its detected setups/payoffs against the authored reader-map hooks/payoffs.',
    scope: 'series',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
      // Issue gap at/above which a paid-off setup is flagged as a DISTANT payoff
      // (#1595) — setup in issue 1, payoff in issue 1+distantGap or later, far
      // enough that the reader may not still recall the plant. 0 disables the
      // distant sub-check (only false-setup / orphaned-payoff are reported).
      distantGap: z.number().int().min(0).max(20).default(4),
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
      {
        key: 'distantGap',
        label: 'Distant-payoff issue gap',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        help: 'Flag a payoff this many issues (or more) after its setup as "distant" — the reader may have forgotten the plant. Set to 0 to disable the distant check.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // Authored hooks/payoffs + the foreshadowing ledger (#2172) are fixed
      // per-call overhead (re-sent on each chunk). The ledger is folded into the
      // same authoredSetups block so the prompt consumes it unchanged.
      const authoredSetups = authoredSetupPayoffSummary(ctx.series?.arc?.readerMap, ctx.series?.arc?.foreshadowing);
      // 0 disables the distant sub-check; >0 is the issue-gap threshold. Pass a
      // string so the prompt's `{{#distantGap}}` section renders only when enabled.
      const distantGap = ctx.config?.distantGap ?? 4;
      const distantEnabled = distantGap > 0;
      return runManuscriptLlmCheck(ctx, {
        stage: CHEKHOV_STAGE,
        category: 'continuity',
        context: { authoredSetups },
        // `finalPart` gates the whole-corpus "planted, never fired" judgment to the
        // last part of a chunked manuscript (#1299) — an earlier part can't know a
        // setup pays off later, so it would false-flag. A single-chunk run is its own
        // final part. "fired, never planted" and "distant payoff" stay enabled on
        // every part (the carried setup digest tells a later part what was already
        // planted, and in which issue, so the issue gap can be measured at payoff).
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          authoredSetups: c.authoredSetups,
          finalPart: meta?.isFinal ? 'true' : '',
          distantGap: distantEnabled ? String(distantGap) : '',
        }),
        // A setup planted in chapter 2 and paid off (or NOT) in chapter 9 spans
        // chunks — the cross-chunk digest keeps prior findings in view so a later
        // chunk doesn't re-flag, and the clean-setup digest rolls forward which
        // elements have been planted-but-not-yet-paid so a payoff isn't mis-flagged
        // "no setup" and a never-fired plant is caught at the end.
        crossChunkDigest: true,
        crossChunkSetup: true,
        // Only ask the cross-chunk setup digest to track each element's plant issue
        // when distant detection is on — that issue number is used solely to measure
        // the setup→payoff gap (#1595), so tracking it with the distant check
        // disabled is wasted digest work.
        setupFocus: 'Planted elements that a later scene should pay off — weapons/objects/clues, '
          + 'secrets, stated fears, promises/vows, threats, and notable skills — and, for each, '
          + (distantEnabled ? 'the issue number it was first planted in, and ' : '')
          + 'whether it has already been paid off (fired, spilled, confronted, kept) or is still open.',
      });
    },
  },
];
