// Editorial checks — dialogue group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  DIALOGUE_PLEASANTRIES_STAGE,
  EDITORIAL_PROMPT_OVERHEAD_TOKENS,
  ON_THE_NOSE_STAGE,
  ON_THE_NOSE_SUBTYPES,
  VOICE_DISTINCTIVENESS_STAGE,
  characterVoiceProfiles,
  findDialogueTagVariety,
  findSaidBookisms,
  findUnattributedDialogueRuns,
  runManuscriptLlmCheck,
  sceneLabel,
  splitPhraseList,
  z,
} from '../checkInfra.js';

export const dialogueChecks = [
  {
    id: 'dialogue.pleasantries',
    sources: ['manuscript'],
    label: 'Empty greeting / small-talk openings',
    description:
      'LLM scan — flags scenes that open on empty greeting or small-talk exchanges ("Hi." "Hi, how are you?") that carry no tension or information. Dialogue should start in the middle of the exchange that matters.',
    scope: 'issue',
    kind: 'llm',
    category: 'dialogue',
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
    // Localized to scene openings — plain per-chunk run, no digest.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: DIALOGUE_PLEASANTRIES_STAGE,
      category: 'dialogue',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'dialogue.said-bookisms',
    sources: ['manuscript'],
    label: 'Said-bookisms & non-speech dialogue tags',
    description:
      'Flags ornate speech tags ("expostulated", "opined", "interjected") and non-speech actions misused as tags ("\'Yes,\' she smiled" — you cannot smile a line). Deterministic scan that only fires on verbs adjacent to a quoted line, so narrated uses of the same verb ("the engine growled") are left alone. Prefer "said"/"asked" plus an action beat.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'dialogue',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) to anchor each tag.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a tag-heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
      // House-style allowlist / extra bookism verbs (comma- or newline-separated).
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a tag-heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Speech-tag verbs to leave alone (comma-separated or one per line) — a genre voice may keep some.' },
      { key: 'extraWords', label: 'Extra bookisms to flag', type: 'text', help: 'Series-specific ornate tags to add (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const allowWords = splitPhraseList(cfg.allowWords);
      const extraWords = splitPhraseList(cfg.extraWords);
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const hits = findSaidBookisms(s?.content || '', { allowWords, extraWords });
        for (const hit of hits) {
          if (findings.length >= max) break;
          const issueNumber = Number.isInteger(s?.number) ? s.number : null;
          const location = issueNumber != null ? `Issue ${issueNumber}` : 'Manuscript';
          const problem = hit.kind === 'non-speech'
            ? `"${hit.anchor}" uses a non-speech action ("${hit.verb}") as a dialogue tag — you cannot ${hit.verb} a line of dialogue.`
            : `"${hit.anchor}" uses the said-bookism "${hit.verb}" as a dialogue tag — ornate tags pull readers out and call attention to the prose.`;
          findings.push({
            severity: ctx.severityDefault,
            category: 'dialogue',
            location,
            problem,
            suggestion: hit.kind === 'non-speech'
              ? `Split it into a tag and a beat: "Of course." She smiled. — let the action stand on its own sentence.`
              : `Use "said" or "asked" and let an action beat or the line itself carry the tone.`,
            anchorQuote: hit.anchor,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'dialogue.attribution-clarity',
    sources: ['manuscript'],
    label: 'Dialogue attribution clarity (untrackable speakers)',
    description:
      'Flags long runs of consecutive dialogue lines with no speech tag or action beat to re-anchor who is speaking — past a few exchanges the reader loses track of which character has the line. Deterministic scan over the stitched manuscript; an attributed line (a tag or a grounding beat) resets the run.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'dialogue',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) to anchor each run.
    needsManuscript: true,
    configSchema: z.object({
      // Consecutive untagged/unbeated dialogue lines before a run is flagged.
      minRun: z.number().int().min(2).max(20).default(6),
      // Non-quoted chars in a dialogue paragraph that count as a grounding beat.
      beatChars: z.number().int().min(0).max(80).default(16),
      // Cap findings per run so a dialogue-heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      { key: 'minRun', label: 'Untagged lines in a row to flag', type: 'number', min: 2, max: 20, step: 1, help: 'How many consecutive dialogue lines with no tag or action beat before the speaker becomes hard to track. Two speakers alternating stay trackable for a few exchanges; a longer run is where it fails.' },
      { key: 'beatChars', label: 'Action-beat threshold (characters)', type: 'number', min: 0, max: 80, step: 1, help: 'How many non-quoted characters a dialogue paragraph needs to count as carrying a grounding action beat (which re-anchors the speaker).' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a dialogue-heavy draft can not flood the review.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const minRun = cfg.minRun ?? 6;
      const beatChars = cfg.beatChars ?? 16;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const runs = findUnattributedDialogueRuns(s?.content || '', { minRun, beatChars });
        for (const run of runs) {
          if (findings.length >= max) break;
          const issueNumber = Number.isInteger(s?.number) ? s.number : null;
          findings.push({
            severity: ctx.severityDefault,
            category: 'dialogue',
            location: issueNumber != null ? `Issue ${issueNumber}` : 'Manuscript',
            problem: `${run.count} dialogue lines in a row with no speech tag or action beat (starting "${run.anchor}") — past a few exchanges the reader can't track who is speaking.`,
            suggestion: 'Drop in an occasional "said"/"asked" or a short action beat to re-anchor the speaker — every few lines is enough to keep a long exchange clear.',
            anchorQuote: run.anchor,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'dialogue.tag-variety',
    sources: ['manuscript'],
    label: 'Dialogue tag variety / within-scene tag monotony',
    description:
      'Flags the opposite tics from said-bookisms at the scene grain: one tag verb hammered over and over ("she said" eight times in a scene — monotony) or a different fancy verb on nearly every line ("said/asked/replied/murmured/whispered" churn — over-variation). Deterministic scan that inventories speech tags (plain + ornate) adjacent to quoted lines, scene by scene. The craft target is mostly the invisible "said"/"asked" with enough variation to stay unnoticed.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'dialogue',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections), split into scenes.
    needsManuscript: true,
    configSchema: z.object({
      // A scene needs at least this many speech tags before variety is judged —
      // a handful of tags can't be "monotonous" or "over-varied" meaningfully.
      minTags: z.number().int().min(3).max(40).default(6),
      // Monotony: dominant verb must hit BOTH a raw count and a share-of-tags ratio.
      monotonyCount: z.number().int().min(2).max(40).default(6),
      monotonyRatio: z.number().min(0.4).max(1).default(0.7),
      // Over-variation: distinct verbs ÷ tags must exceed this with ≥ minDistinct verbs.
      overVariationRatio: z.number().min(0.5).max(1).default(0.85),
      minDistinct: z.number().int().min(2).max(20).default(5),
      // Cap findings per run so a dialogue-heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
      // House-style allowlist (mute a tag verb) / extra ornate tags to count.
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'minTags', label: 'Min tags per scene to judge', type: 'number', min: 3, max: 40, step: 1, help: 'A scene needs at least this many speech tags before its variety is assessed.' },
      { key: 'monotonyCount', label: 'Monotony: dominant-verb count', type: 'number', min: 2, max: 40, step: 1, help: 'How many times one tag verb must recur in a scene to count toward monotony.' },
      { key: 'monotonyRatio', label: 'Monotony: dominant-verb share', type: 'number', min: 0.4, max: 1, step: 0.05, help: 'Fraction of the scene\'s tags the dominant verb must own (0–1) to flag monotony.' },
      { key: 'overVariationRatio', label: 'Over-variation: distinct share', type: 'number', min: 0.5, max: 1, step: 0.05, help: 'Distinct-verbs ÷ total-tags above this (0–1) reads as thesaurus churn.' },
      { key: 'minDistinct', label: 'Over-variation: min distinct verbs', type: 'number', min: 2, max: 20, step: 1, help: 'At least this many distinct tag verbs before over-variation can fire.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a dialogue-heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Tag verbs to leave out of the inventory (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra ornate tags to count', type: 'text', help: 'Series-specific ornate tags to include in the inventory (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const allowWords = splitPhraseList(cfg.allowWords);
      const extraWords = splitPhraseList(cfg.extraWords);
      const opts = {
        allowWords,
        extraWords,
        minTags: cfg.minTags ?? 6,
        monotonyCount: cfg.monotonyCount ?? 6,
        monotonyRatio: cfg.monotonyRatio ?? 0.7,
        overVariationRatio: cfg.overVariationRatio ?? 0.85,
        minDistinct: cfg.minDistinct ?? 5,
      };
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const hits = findDialogueTagVariety(s?.content || '', opts);
        for (const hit of hits) {
          if (findings.length >= max) break;
          const issueNumber = Number.isInteger(s?.number) ? s.number : null;
          const location = issueNumber != null ? `Issue ${issueNumber}` : 'Manuscript';
          const sceneLabel = `scene ${hit.sceneOrdinal}`;
          const problem = hit.type === 'monotony'
            ? `The tag "${hit.verb}" carries ${hit.count} of ${hit.total} dialogue tags in ${sceneLabel} — one repeated tag verb turns monotonous and starts to call attention to itself.`
            : `${sceneLabel} uses ${hit.distinct} different tag verbs across ${hit.total} tagged lines — a fresh verb on nearly every line reads as thesaurus churn and pulls the reader out.`;
          findings.push({
            severity: ctx.severityDefault,
            category: 'dialogue',
            location,
            problem,
            suggestion: hit.type === 'monotony'
              ? 'Vary the rhythm: drop some tags entirely (let an action beat carry the speaker) and swap a few for "asked"/a beat so no single tag dominates.'
              : 'Lean on the invisible "said"/"asked" for most lines and reserve a distinctive tag for the moments that earn it — constant variation is as distracting as monotony.',
            anchorQuote: hit.anchor,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'dialogue.on-the-nose',
    sources: ['manuscript'],
    label: 'On-the-nose / subtext-free dialogue (LLM)',
    description:
      'LLM scan for dialogue that states exactly what a character feels or means with no subtext, and "maid-and-butler" exchanges where characters tell each other what they both already know. Each finding is sub-classified (#1626) as exposition (info-dump), emotion-tell (naming a feeling outright), or relationship-report (describing a bond instead of dramatizing it) so the fix is actionable. Complements the info-dumping check (#1297) — that targets backstory exposition, this targets emotionally flat, subtext-free lines.',
    scope: 'issue',
    kind: 'llm',
    category: 'dialogue',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a long manuscript can not flood the review.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    // Localized prose-level findings (one on-the-nose line = one spot), so this
    // stays a plain per-chunk run with no cross-chunk digest — mirrors prose.info-dumping.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: ON_THE_NOSE_STAGE,
      category: 'dialogue',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
      // The prompt classifies each finding (#1626) into why it reads on-the-nose;
      // the runner validates the model's label against this set and stamps it as
      // `subtype` on the finding so the editor sees exposition / emotion-tell /
      // relationship-report instead of a flat "on-the-nose".
      subtypes: ON_THE_NOSE_SUBTYPES,
    }),
  },
  {
    id: 'dialogue.voice-distinctiveness',
    sources: ['manuscript', 'canon'],
    label: 'Character voice distinctiveness (LLM)',
    description:
      "LLM scan that samples each character's dialogue and flags (a) characters whose lines are interchangeable — everyone sounds like one narrator — and (b) lines that contradict the character's canon speechPattern / speechAccent. Produces a per-character voice fingerprint and names concrete differentiating tics. Closes the gap where voice fields fed generation only and nothing validated the drafted dialogue against them.",
    scope: 'series',
    kind: 'llm',
    category: 'dialogue',
    severityDefault: 'medium',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus AND the canon voice fields.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a large cast can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a large cast can not flood the review.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // The authored voice profiles are fixed per-call overhead (re-sent on each
      // chunk) and pure context: they let the model reconcile a character's drafted
      // lines against their canon speechPattern/speechAccent. The check degrades
      // gracefully — no voice fields ⇒ {{#voiceProfiles}} renders nothing and the
      // check still scans for interchangeable voices across the cast.
      const voiceProfiles = characterVoiceProfiles(ctx.canon);
      return runManuscriptLlmCheck(ctx, {
        stage: VOICE_DISTINCTIVENESS_STAGE,
        category: 'dialogue',
        // The authored voice profiles are re-sent per chunk — trimmed to keep the
        // manuscript a budget floor on a small window.
        context: { voiceProfiles },
        buildVars: (manuscript, _meta, c) => ({ manuscript, voiceProfiles: c.voiceProfiles }),
        // Voice distinctiveness is a whole-cast judgment: a character's lines are
        // spread across chapters, so a per-chunk view can't tell "interchangeable"
        // from "we only saw one speaker this chunk". Roll a per-character voice-
        // sample digest forward so a later chunk judges against the full sample.
        crossChunkSetup: true,
        setupFocus:
          'For each named character, capture a few representative dialogue lines and a one-phrase sketch of their voice (diction, rhythm, verbal tics, accent markers). Carry these samples forward so a later chunk can judge whether characters sound distinct from one another and consistent with their established voice.',
      });
    },
  },
];
