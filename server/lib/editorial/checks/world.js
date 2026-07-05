// Editorial checks — world group (#2175). Worldbuilding-doctrine checks: the
// review-side companion to the Sanderson's-Laws doctrine injected into the
// universe-expansion generation prompt. Each entry is a declarative check; see
// ../README.md and ../checkInfra.js.
import {
  WORLD_COST_FREE_POWER_STAGE,
  WORLD_UNFORESHADOWED_SOLUTION_STAGE,
  canonWorldSummary,
  continuityLedgerSummary,
  runManuscriptLlmCheck,
  z,
} from '../checkInfra.js';

// Shared config: cap findings per run so a long manuscript can't flood the review.
const maxFindingsSchema = z.object({
  maxFindings: z.number().int().min(1).max(50).default(12),
});
const maxFindingsFields = [
  {
    key: 'maxFindings',
    label: 'Max findings per run',
    type: 'number',
    min: 1,
    max: 50,
    step: 1,
    help: 'Cap findings so a long manuscript can not flood the review.',
  },
];

export const worldChecks = [
  {
    id: 'world.unforeshadowed-solution',
    sources: ['manuscript', 'canon', 'continuityBible'],
    label: 'Unforeshadowed solution (worldbuilding deus ex machina)',
    description:
      "LLM scan — the worldbuilding sibling of the plot-level deus ex machina (plot.structure-momentum). Flags a plot problem resolved by a rule, power, property, or artifact the reader was NEVER shown before it saves the day (Sanderson's First Law: the ability to solve problems with magic is proportional to how well the reader understands it). Reconciles the prose against the established world canon (named artifacts/objects + places) and the continuity-bible world-rule facts, so a rule that WAS planted earlier is NOT flagged. Because a solution can be foreshadowed pages earlier, whole-arc verdicts land on the final manuscript part with the earlier plants carried in the setup digest; degrades to a prose-only scan when no canon or world-rules exist.",
    scope: 'series',
    kind: 'llm',
    category: 'world',
    // Fallback severity when the model omits one — 'medium' to match the sibling
    // plot/continuity LLM checks. The prompt directs the model to mark a climactic
    // solution built on a wholly-unplanted rule 'high' per finding.
    severityDefault: 'medium',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: maxFindingsSchema,
    configFields: maxFindingsFields,
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // Both blocks are fixed per-call overhead (re-sent on each chunk) and pure
      // context: the world canon names the artifacts/powers/places a solution may
      // legitimately draw on, and the continuity-bible world-rule facts add the
      // established mechanics. The check degrades gracefully — no canon ⇒
      // {{#canonWorld}} renders nothing; no world-rule facts ⇒ {{#worldRules}}
      // renders nothing and the model reasons from the prose's own setups.
      const canonWorld = canonWorldSummary(ctx.canon);
      const worldRules = continuityLedgerSummary(ctx.continuityBible);
      return runManuscriptLlmCheck(ctx, {
        stage: WORLD_UNFORESHADOWED_SOLUTION_STAGE,
        category: 'world',
        context: { canonWorld, worldRules },
        buildVars: (manuscript, meta, c) => ({
          manuscript,
          canonWorld: c.canonWorld,
          worldRules: c.worldRules,
          finalPart: meta?.isFinal ? 'true' : '',
        }),
        // A solution's setup can be planted chapters before it fires — the findings
        // digest keeps prior findings in view so a later chunk doesn't re-flag, and
        // the clean-setup digest rolls forward every rule/power/artifact the prose
        // has ESTABLISHED so the final part can tell an unforeshadowed solution from
        // one whose plant simply sits in an earlier chunk. `isFinal` gates the
        // verdict — a non-final chunk can't know a rule used here is established later.
        crossChunkDigest: true,
        crossChunkSetup: true,
        // The verdict is gated to the final part and anchored on the carried set of
        // established rules, so reserve room for the digest in the packed final chunk.
        reserveSetupDigest: true,
        setupFocus:
          'Track every magic/tech rule, power, property, or artifact the prose has ESTABLISHED so far (introduced, demonstrated, or explained to the reader) and where it was planted. Carry these forward so the final part can tell a solution built on an established-and-planted rule (fine) from one that draws on a capability the reader was never shown before it resolved the problem (unforeshadowed).',
      });
    },
  },
  {
    id: 'world.cost-free-power',
    sources: ['manuscript', 'canon', 'continuityBible'],
    label: 'Cost-free power (limitation-free ability at a decisive moment)',
    description:
      "LLM scan — flags an ability, technology, or magic used at a DECISIVE moment (resolving a conflict, escaping danger, turning a scene) with no cost, limitation, or price paid on the page (Sanderson's Second Law: limitations are more interesting than powers). A power that always works, at any scale, with no drawback drains tension from every scene it touches. Reconciles against the established world canon and continuity-bible world-rule facts, so a use that DOES pay the established cost — or a power the canon defines as genuinely limitless for a reason — is not flagged. Judges each decisive use in place; a per-scene finding, so it runs per chunk without a whole-arc gate.",
    scope: 'series',
    kind: 'llm',
    category: 'world',
    severityDefault: 'medium',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: maxFindingsSchema,
    configFields: maxFindingsFields,
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // Both blocks are fixed per-call overhead (re-sent on each chunk) and pure
      // context: the world canon + continuity world-rule facts state the costs and
      // limitations each system is SUPPOSED to carry, so the model can tell a use
      // that skips the established price from a system that legitimately has none.
      const canonWorld = canonWorldSummary(ctx.canon);
      const worldRules = continuityLedgerSummary(ctx.continuityBible);
      return runManuscriptLlmCheck(ctx, {
        stage: WORLD_COST_FREE_POWER_STAGE,
        category: 'world',
        context: { canonWorld, worldRules },
        buildVars: (manuscript, _meta, c) => ({
          manuscript,
          canonWorld: c.canonWorld,
          worldRules: c.worldRules,
        }),
        // A cost-free use is judged in place (a decisive beat with no price paid),
        // so this stays a plain per-chunk run — but the setup digest carries each
        // power's established cost forward so a later chunk knows what price a use
        // was supposed to pay, and the findings digest stops a re-flag of the same
        // power across chunks.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus:
          'For each magic/tech power or ability the prose features, note the cost, limitation, or price the story has established it carries (fuel, blood, memory, time, reputation, physical toll, a hard cap on scale/range). Carry these forward so a later chunk can tell a decisive use that pays the established price from one that skips it.',
      });
    },
  },
];
