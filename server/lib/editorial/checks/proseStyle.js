// Editorial checks — proseStyle group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  ADVERSARIAL_CUTS_STAGE,
  CUT_TYPES,
  DEAD_METAPHOR_STAGE,
  EDITORIAL_PROMPT_OVERHEAD_TOKENS,
  INFO_DUMPING_STAGE,
  KILL_YOUR_DARLINGS_STAGE,
  MIRROR_DESCRIPTION_STAGE,
  STYLE_CONFORMANCE_STAGE,
  TELLING_EMOTION_STAGE,
  VOICE_CONSISTENCY_STAGE,
  countWords,
  escalateSeverity,
  filterPassiveVoice,
  findAdverbs,
  findCliches,
  findCrutchWords,
  findFilterWords,
  findGestures,
  findHedgeWords,
  findItalicThoughts,
  findModifierStacking,
  findPassiveVoice,
  findRepeatedOpeners,
  findWordEchoes,
  hasConformanceFields,
  intendedVoiceSummary,
  measureSentenceRhythm,
  readingGradeLevel,
  readingLevelByScene,
  runDensityCheck,
  runManuscriptLlmCheck,
  sceneReadingAnchor,
  sectionIssue,
  splitPhraseList,
  styleGuideExpectations,
  z,
} from '../checkInfra.js';
import {
  computeVoiceDrift, describeDrift, parseVoiceWells, VOICE_BASELINE_MODES,
} from '../voiceFingerprint.js';

export const proseStyleChecks = [
  {
    id: 'prose.info-dumping',
    sources: ['manuscript'],
    label: 'Info-dumping / "as you know, Bob" exposition',
    description:
      'Flags passages that dump backstory or world rules through unnatural exposition — characters telling each other what they both already know.',
    scope: 'issue',
    kind: 'llm',
    category: 'exposition',
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
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: INFO_DUMPING_STAGE,
      category: 'exposition',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'style.reading-level',
    sources: ['manuscript', 'series.styleGuide'],
    label: 'Reading-level conformance',
    description:
      "Measures the drafted manuscript's reading grade level (Flesch–Kincaid) and flags it when the whole-corpus level drifts beyond a tolerance from the series style guide's target. Also reports per-scene reading-level variance: a single scene whose grade swings far outside the target band (target ± scene tolerance) is flagged even when the corpus average sits on target — surfacing the modulation a one-number check averages away.",
    scope: 'series',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript to measure the actual grade level.
    needsManuscript: true,
    configSchema: z.object({
      // How many grade levels the whole-corpus reading level may drift from the
      // target before it's flagged.
      tolerance: z.number().int().min(0).max(6).default(2),
      // Half-width of the per-scene target band: a scene whose grade lands more
      // than this many levels from the target is flagged as an out-of-band swing.
      // Wider than `tolerance` by default — scenes legitimately modulate, so only
      // the extreme outliers are worth a finding.
      sceneTolerance: z.number().int().min(1).max(8).default(4),
      // Minimum words a scene needs before its reading level is judged — a short
      // fragment's FK estimate is too noisy to trust.
      minSceneWords: z.number().int().min(20).max(2000).default(120),
      // Cap per-scene findings so a long manuscript with many outliers can't
      // flood the review (worst swings are reported first).
      maxSceneFindings: z.number().int().min(1).max(20).default(5),
    }),
    configFields: [
      {
        key: 'tolerance',
        label: 'Whole-corpus tolerance (grades)',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        help: 'How many grade levels the whole-manuscript reading level may differ from the style-guide target before it is flagged.',
      },
      {
        key: 'sceneTolerance',
        label: 'Per-scene band tolerance (grades)',
        type: 'number',
        min: 1,
        max: 8,
        step: 1,
        help: 'Half-width of the per-scene target band. A single scene whose reading level swings more than this many grades from the target is flagged, even when the whole-manuscript average is on target.',
      },
      {
        key: 'minSceneWords',
        label: 'Minimum scene words to measure',
        type: 'number',
        min: 20,
        max: 2000,
        step: 10,
        help: 'Scenes shorter than this are skipped — a brief fragment is too short for a reliable reading-level estimate.',
      },
      {
        key: 'maxSceneFindings',
        label: 'Max per-scene findings',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        help: 'Cap on per-scene out-of-band findings so a long manuscript can not flood the review. The widest swings are reported first.',
      },
    ],
    // Only run when the style guide sets a target AND there's prose to measure.
    gate: (ctx) => Number.isFinite(ctx.series?.styleGuide?.readingLevel)
      && (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const target = ctx.series?.styleGuide?.readingLevel;
      if (!Number.isFinite(target)) return [];
      const grade = readingGradeLevel(ctx.manuscript);
      if (grade == null) return [];
      const tolerance = ctx.config?.tolerance ?? 2;
      const sceneTolerance = ctx.config?.sceneTolerance ?? 4;
      const minSceneWords = ctx.config?.minSceneWords ?? 120;
      const maxSceneFindings = ctx.config?.maxSceneFindings ?? 5;
      const findings = [];

      // 1. Whole-corpus drift from the target (the original #1303 behavior).
      const rounded = Math.round(grade * 10) / 10;
      const delta = rounded - target;
      if (Math.abs(delta) > tolerance) {
        const tooHard = delta > 0;
        const off = Math.round(Math.abs(delta) * 10) / 10;
        findings.push({
          severity: ctx.severityDefault,
          category: 'style',
          location: 'Series manuscript (whole-corpus reading level)',
          problem: `The drafted manuscript reads at about a grade-${rounded} level, ${tooHard ? 'above' : 'below'} the style-guide target of grade ${target} (off by ${off} grade${off === 1 ? '' : 's'}).`,
          suggestion: tooHard
            ? 'Shorten sentences and prefer plainer words to bring the reading level down toward the target.'
            : 'Vary sentence length and vocabulary to raise the reading level toward the target.',
          anchorQuote: '',
          issueNumber: null,
        });
      }

      // 2. Per-scene variance (#1625): flag scenes whose grade falls outside the
      // target band [target ± sceneTolerance]. The whole-corpus average above can
      // hide a lone scene that swings far past the band, so report the worst
      // out-of-band swings (capped). Needs at least 2 measurable scenes — a
      // single-scene corpus has no spread to report beyond the whole-corpus check.
      const bandLow = target - sceneTolerance;
      const bandHigh = target + sceneTolerance;
      const scenes = readingLevelByScene(ctx.manuscript, minSceneWords);
      if (scenes.length >= 2) {
        // How far a grade sits OUTSIDE the band (0 inside; positive when out) —
        // the filter and the worst-first sort share this one definition.
        const outsideBand = (g) => Math.max(g - bandHigh, bandLow - g, 0);
        const outliers = scenes
          .filter((s) => outsideBand(s.grade) > 0)
          .sort((a, b) => outsideBand(b.grade) - outsideBand(a.grade))
          .slice(0, maxSceneFindings);
        for (const s of outliers) {
          const tooHard = s.grade > bandHigh;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location: `Series manuscript — scene ${s.ordinal} (${s.words} words)`,
            problem: `Scene ${s.ordinal} reads at about a grade-${s.grade} level, ${tooHard ? 'above' : 'below'} the target band of grade ${bandLow}–${bandHigh} (target ${target} ± ${sceneTolerance}). A single scene swinging this far outside the band is hidden by the whole-corpus average.`,
            suggestion: tooHard
              ? 'If this scene is meant to read denser (action, exposition), confirm it is intentional; otherwise shorten sentences and simplify vocabulary to pull it toward the band.'
              : 'If this scene is meant to read simpler (quiet introspection, sparse dialogue), confirm it is intentional; otherwise vary sentence length and vocabulary to raise it toward the band.',
            anchorQuote: sceneReadingAnchor(s.text),
            issueNumber: null,
          });
        }
      }

      return findings;
    },
  },
  {
    id: 'style.conformance',
    sources: ['manuscript', 'series.styleGuide'],
    label: 'Style-guide conformance (tense / POV / rating)',
    description:
      "LLM scan — flags passages where the prose drifts from the series style guide's tense, point-of-view person, or content rating (profanity/violence/sexual content beyond the configured ceiling).",
    scope: 'issue',
    kind: 'llm',
    category: 'style',
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
    // Skip unless there's prose AND the style guide declares at least one
    // conformance-relevant field (tense / POV / rating / profanity / audience).
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0
      && hasConformanceFields(ctx.series?.styleGuide),
    run: (ctx) => {
      const expectations = styleGuideExpectations(ctx.series?.styleGuide);
      if (!expectations) return [];
      return runManuscriptLlmCheck(ctx, {
        stage: STYLE_CONFORMANCE_STAGE,
        category: 'style',
        // The style-guide expectations are re-sent per chunk — trimmed to keep the
        // manuscript a budget floor on a small window.
        context: { styleGuide: expectations },
        buildVars: (manuscript, _meta, c) => ({ manuscript, styleGuide: c.styleGuide }),
        // Tense/POV drift is inherently cross-chapter — a per-chunk view can't see
        // that chapter 1 established past-tense when judging chapter 3 (#1383).
        crossChunkDigest: true,
        // A chunk with no tense/POV finding leaves a later chunk blind to what
        // chapter 1 established — the findings digest carries problems, not the clean
        // baseline. Roll a setup summary of the tense/POV/rating in force forward (#1403).
        crossChunkSetup: true,
        setupFocus: 'The narrative tense (past/present), the point-of-view person (first/third/etc.), '
          + 'and the content rating / profanity / violence level in force.',
      });
    },
  },
  {
    id: 'prose.cliches',
    sources: ['manuscript'],
    label: 'Cliché phrases (stock similes / idioms)',
    description:
      'Flags stock similes and idioms — "heart pounding like a drum", "time stood still", "little did they know" — tired phrasing that pulls readers out. Deterministic scan of a seed phrase list; extend or mute entries per house style. The LLM sibling catches novel clichés the list misses.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) to anchor each cliché.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a cliché-heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
      // House-style allowlist: clichés to leave alone (one per line or comma-separated)
      // — an intentional cliché in a character's voice or a genre beat.
      allowPhrases: z.string().default(''),
      // Series-specific clichés to add to the seed list (one per line or comma-separated).
      extraPhrases: z.string().default(''),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a cliché-heavy draft can not flood the review.',
      },
      {
        key: 'allowPhrases',
        label: 'House-style allowlist',
        type: 'text',
        help: 'Clichés to leave alone (comma-separated or one per line) — intentional voice or genre beats.',
      },
      {
        key: 'extraPhrases',
        label: 'Extra clichés to flag',
        type: 'text',
        help: 'Series-specific stock phrases to add to the seed list (comma-separated or one per line).',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const allowPhrases = splitPhraseList(cfg.allowPhrases);
      const extraPhrases = splitPhraseList(cfg.extraPhrases);
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      // One finding per distinct cliché (anchored to the first issue it appears
      // in) — a cliché repeated across the draft is one tic to fix, not many.
      const seenPhrases = new Set();
      for (const s of sections) {
        if (findings.length >= max) break;
        const hits = findCliches(s?.content || '', { allowPhrases, extraPhrases });
        for (const hit of hits) {
          if (findings.length >= max) break;
          const key = hit.phrase.toLowerCase();
          if (seenPhrases.has(key)) continue;
          seenPhrases.add(key);
          const issueNumber = Number.isInteger(s?.number) ? s.number : null;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location: issueNumber != null ? `Issue ${issueNumber}` : 'Manuscript',
            problem: `Cliché phrase "${hit.anchor}" — a stock simile/idiom that reads as filler and pulls readers out of the prose.`,
            suggestion: 'Replace with fresh, specific phrasing true to this moment — or add it to this check\'s house-style allowlist if the cliché is intentional voice.',
            anchorQuote: hit.anchor,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.modifier-stacking',
    sources: ['manuscript'],
    label: 'Overwriting — stacked adjectives / adverbs',
    description:
      'Flags overwriting: runs of three or more piled-up single-word modifiers ("big red shiny new") before a noun. Deterministic and high-precision (cumulative, no-comma runs only); coordinate lists and purple prose beyond a simple stack are left to the LLM sibling.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Run length (consecutive modifiers) to flag. 3 is the classic "too many
      // adjectives" threshold; raise it to only catch the most egregious piles.
      minStack: z.number().int().min(3).max(8).default(3),
      // Cap findings per run so an adjective-heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      {
        key: 'minStack',
        label: 'Modifiers in a row to flag',
        type: 'number',
        min: 3,
        max: 8,
        step: 1,
        help: 'How many consecutive single-word modifiers (with no commas between them) before a noun trips the check. 3 catches "big red shiny new"; raise it for only the worst piles.',
      },
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so an adjective-heavy draft can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const minStack = cfg.minStack ?? 3;
      const max = cfg.maxFindings ?? 20;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const runs = findModifierStacking(s?.content || '', { minStack });
        for (const run of runs) {
          if (findings.length >= max) break;
          const issueNumber = Number.isInteger(s?.number) ? s.number : null;
          findings.push({
            // A longer pile (5+) is more clearly overwriting — escalate above the low floor.
            severity: escalateSeverity(ctx.severityDefault, run.count >= 5 ? 1 : 0),
            category: 'style',
            location: issueNumber != null ? `Issue ${issueNumber}` : 'Manuscript',
            problem: `${run.count} modifiers stacked in a row ("${run.anchor}") — piling adjectives/adverbs dilutes each one and reads as overwriting.`,
            suggestion: 'Cut to the one or two strongest, most specific modifiers (or replace the noun phrase with a stronger noun/verb).',
            anchorQuote: run.anchor,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.filter-words',
    sources: ['manuscript'],
    label: 'Filter words (distancing verbs)',
    description:
      'Flags distancing verbs that narrate experience instead of dramatizing it — "she saw the door open", "he felt the cold", "they noticed a shadow". Density-scaled: a high per-1000-word rate of saw/watched/noticed/realized/felt/heard/seemed/wondered/began-to is the tic. Collapse to direct experience ("the door opened").',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Per-1000-word rate at/above which a section is flagged.
      densityPer1000: z.number().min(0).max(50).default(6),
      // Cap findings per run so a heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
      // House-style allowlist / extra filter words (comma- or newline-separated).
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'densityPer1000', label: 'Filter-word rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose filter-word frequency per 1000 words is at or above this. One "saw" is fine; a steady drumbeat is the tic.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Filter words to leave alone (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra filter words to flag', type: 'text', help: 'Series-specific distancing verbs to add (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => runDensityCheck(ctx, {
      scan: (text, cfg) => findFilterWords(text, { allowWords: splitPhraseList(cfg.allowWords), extraWords: splitPhraseList(cfg.extraWords) }),
      noun: 'filter words',
      problem: (count, rate, anchor) => `${count} filter word${count === 1 ? '' : 's'} (e.g. "${anchor}") — about ${rate}/1000 words. Distancing verbs put a layer of narration between the reader and the experience.`,
      suggestion: 'Collapse to direct experience — "she saw the door open" → "the door opened" — or add intentional uses to the allowlist.',
    }),
  },
  {
    id: 'prose.hedge-words',
    sources: ['manuscript'],
    label: 'Hedge / weasel words (distance markers)',
    description:
      'Flags hedge and weasel constructions that soften prose and back the reader out of the moment — metaphorical distance ("as if", "somewhere deep inside", "almost", "part of him"), dialogue/cognitive hedges ("kind of", "sort of", "I suppose", "more or less"), and cognitive weasel words ("surely", "no doubt", "obviously", "of course"). Density-scaled per-1000-word frequency: an occasional hedge is fine, a steady drumbeat reads as a narrator who won\'t commit. Separate from the perception-verb bucket in prose.filter-words.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Per-1000-word rate at/above which a section is flagged.
      densityPer1000: z.number().min(0).max(50).default(7),
      // Cap findings per run so a heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
      // House-style allowlist / extra hedge words (comma- or newline-separated).
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'densityPer1000', label: 'Hedge-word rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose hedge/weasel-word frequency per 1000 words is at or above this. One "perhaps" is fine; a steady drumbeat is the tic.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Hedge words to leave alone (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra hedge words to flag', type: 'text', help: 'Series-specific hedges/weasel words to add (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => runDensityCheck(ctx, {
      scan: (text, cfg) => findHedgeWords(text, { allowWords: splitPhraseList(cfg.allowWords), extraWords: splitPhraseList(cfg.extraWords) }),
      noun: 'hedge words',
      problem: (count, rate, anchor) => `${count} hedge/weasel word${count === 1 ? '' : 's'} (e.g. "${anchor}") — about ${rate}/1000 words. Hedges and weasel words soften the prose and distance the reader from a committed, dramatized moment.`,
      suggestion: 'Commit to the moment — drop the hedge or dramatize the feeling directly ("part of him almost felt" → "he felt") — or add intentional uses to the allowlist.',
    }),
  },
  {
    id: 'prose.crutch-words',
    sources: ['manuscript'],
    label: 'Crutch / filler words',
    description:
      'Flags intensifier/hedge crutch words that almost always delete cleanly — just, really, very, quite, somewhat, suddenly, actually, basically, "in order to". Density-scaled per-1000-word frequency. Bare "that" (usually deletable) is included only when the toggle is on, since grammatical "that" would swamp the count.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      densityPer1000: z.number().min(0).max(50).default(8),
      maxFindings: z.number().int().min(1).max(50).default(20),
      // Include bare "that" (the deletable relative-clause "that"). Off by default
      // — grammatical "that" is common enough to swamp the density signal.
      includeThat: z.boolean().default(false),
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'densityPer1000', label: 'Crutch-word rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose crutch-word frequency per 1000 words is at or above this.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'includeThat', label: 'Include deletable "that"', type: 'boolean', help: 'Count bare "that" as a crutch word. Off by default — grammatical "that" is common and would swamp the signal.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Crutch words to leave alone (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra crutch words to flag', type: 'text', help: 'Series-specific fillers to add (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => runDensityCheck(ctx, {
      scan: (text, cfg) => findCrutchWords(text, { includeThat: cfg.includeThat === true, allowWords: splitPhraseList(cfg.allowWords), extraWords: splitPhraseList(cfg.extraWords) }),
      noun: 'crutch words',
      problem: (count, rate, anchor) => `${count} crutch/filler word${count === 1 ? '' : 's'} (e.g. "${anchor}") — about ${rate}/1000 words. Intensifiers and hedges like these usually delete cleanly and tighten the prose.`,
      suggestion: 'Delete the filler or replace the propped-up word with a stronger one ("really big" → "enormous").',
    }),
  },
  {
    id: 'prose.adverbs',
    sources: ['manuscript'],
    label: 'Adverb overuse (-ly + dialogue tags)',
    description:
      'Flags overuse of -ly adverbs, especially those propping up weak verbs ("ran quickly" → "sprinted") and emotion-telling dialogue tags ("she said angrily"). Density-scaled; dialogue-tag adverbs split into reporting (manner/volume — "said quietly", an invisible stage direction) and emotion-telling ("said angrily", which the line should carry) buckets, and only the emotion-telling tags are flagged by default — a higher-severity sub-signal because the tag should carry its weight through the dialogue itself.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      densityPer1000: z.number().min(0).max(80).default(15),
      maxFindings: z.number().int().min(1).max(50).default(20),
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
      flagReportingTags: z.boolean().default(false),
    }),
    configFields: [
      { key: 'densityPer1000', label: 'Adverb rate to flag (per 1000 words)', type: 'number', min: 0, max: 80, step: 1, help: 'Flag a section whose -ly adverb frequency per 1000 words is at or above this.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Adverbs to leave alone (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra adverbs to flag', type: 'text', help: 'Series-specific adverbs the -ly heuristic misses, e.g. "fast", "well", "hard" (comma-separated or one per line).' },
      { key: 'flagReportingTags', label: 'Also flag reporting tags', type: 'boolean', help: 'By default only emotion-telling dialogue tags ("said angrily") are flagged; reporting tags ("said quietly") are treated as invisible stage directions. Enable to flag every adverb-laden tag.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const density = cfg.densityPer1000 ?? 15;
      const allowWords = splitPhraseList(cfg.allowWords);
      const extraWords = splitPhraseList(cfg.extraWords);
      // Reporting tags ("said quietly") read as invisible stage directions, so by
      // default only the emotion-telling bucket ("said angrily") trips the
      // higher-severity tag signal (#1592). Opt back into the old flag-every-tag
      // behavior with `flagReportingTags`.
      const flagReportingTags = cfg.flagReportingTags === true;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const text = s?.content || '';
        const words = countWords(text);
        if (words === 0) continue;
        const hits = findAdverbs(text, { allowWords, extraWords });
        if (!hits.length) continue;
        const rate = Math.round((hits.length / words) * 1000 * 10) / 10;
        const tagHits = hits.filter((h) => h.dialogueTag && (flagReportingTags || h.tagAdverbKind === 'emotion'));
        const { number, location } = sectionIssue(s);
        // Emotion-telling dialogue-tag adverbs are flagged regardless of overall
        // density (one "said angrily" is already a tell); the bulk -ly density is
        // gated on rate. When `flagReportingTags` is on, the bucket also includes
        // reporting tags ("said quietly"), so the wording stays neutral rather than
        // claiming every match "names the feeling".
        if (tagHits.length) {
          const plural = tagHits.length === 1 ? '' : 's';
          const problem = flagReportingTags
            ? `${tagHits.length} adverb-laden dialogue tag${plural} (e.g. "${tagHits[0].anchor}") — a dialogue tag propped up by an adverb usually means the line itself should carry the tone.`
            : `${tagHits.length} emotion-telling dialogue tag${plural} (e.g. "${tagHits[0].anchor}") — a dialogue tag that names the feeling usually means the line itself should carry the tone.`;
          findings.push({
            severity: escalateSeverity(ctx.severityDefault, 1),
            category: 'style',
            location,
            problem,
            suggestion: 'Cut the adverb and let the dialogue + action beat convey the tone ("she said angrily" → "she slammed the cup down. “Fine.”").',
            anchorQuote: tagHits[0].anchor,
            issueNumber: number,
          });
          if (findings.length >= max) break;
        }
        if (rate >= density) {
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `${hits.length} -ly adverbs (about ${rate}/1000 words) — adverb overuse, especially propping up weak verbs ("ran quickly").`,
            suggestion: 'Replace verb+adverb pairs with one strong verb ("ran quickly" → "sprinted"); keep only the adverbs that change the meaning.',
            anchorQuote: hits[0].anchor,
            issueNumber: number,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.passive-voice',
    sources: ['manuscript'],
    label: 'Passive voice (overuse)',
    description:
      'Advisory flag for passive-voice overuse — a be-verb + past participle heuristic ("the door was opened", "mistakes were made"). Density-scaled per-1000-word frequency; passive voice is a legitimate choice, so this only flags when the rate is high. A context-tuning pass (#1593) reduces false positives by default: predicate-adjective states ("she was exhausted") and setting/weather mood images ("the sky was streaked") are not counted as weak passive, while an explicit "by <agent>" always counts.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      densityPer1000: z.number().min(0).max(50).default(10),
      maxFindings: z.number().int().min(1).max(50).default(20),
      suppressIntentional: z.boolean().default(true),
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'densityPer1000', label: 'Passive-voice rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose passive-construction frequency per 1000 words is at or above this. Advisory — passive voice is sometimes the right choice.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'suppressIntentional', label: 'Suppress intentional passive', type: 'boolean', help: 'On by default — skip predicate-adjective states ("she was exhausted") and setting/weather mood images ("the sky was streaked"), which are rarely weak passive. Turn off to count every be-verb + participle (the raw heuristic).' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Participles to never treat as passive — archaic/adjectival "-ed" forms like "blessed", "beloved" (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra participles to flag', type: 'text', help: 'Series-specific irregular participles the heuristic misses, e.g. "begun", "hewn" (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      // Parse the word lists once (not per section, the way the adverbs check
      // hoists its own) — runDensityCheck calls scan() for every section.
      const allowWords = splitPhraseList(ctx.config?.allowWords);
      const extraWords = splitPhraseList(ctx.config?.extraWords);
      return runDensityCheck(ctx, {
        scan: (text, cfg) => filterPassiveVoice(
          findPassiveVoice(text, { allowWords, extraWords }),
          { suppressIntentional: cfg?.suppressIntentional !== false },
        ),
        noun: 'passive constructions',
        problem: (count, rate, anchor) => `${count} passive construction${count === 1 ? '' : 's'} (e.g. "${anchor}") — about ${rate}/1000 words. Heavy passive voice distances the reader from who is acting.`,
        suggestion: 'Rephrase to active voice where it sharpens the prose ("the door was opened by Sam" → "Sam opened the door"). Keep passive where the actor is unknown or beside the point.',
      });
    },
  },
  {
    id: 'prose.repeated-gestures',
    sources: ['manuscript'],
    label: 'Repeated gestures / body-part autonomy',
    description:
      'Flags overused body-language gestures (nodded, smiled, shrugged, sighed, frowned) tallied across the manuscript, plus "body-part autonomy" — detached body parts that act on their own ("her eyes followed him across the room", "his hand shot out"). A reader-pet-peeve goldmine.',
    scope: 'series',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // A gesture tallied this many times across the manuscript is flagged.
      maxPerGesture: z.number().int().min(2).max(50).default(8),
      maxFindings: z.number().int().min(1).max(50).default(20),
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'maxPerGesture', label: 'Gesture count to flag', type: 'number', min: 2, max: 50, step: 1, help: 'Flag a gesture verb (nodded, smiled, shrugged…) once its total count across the manuscript reaches this.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Gesture verbs to leave alone (comma-separated or one per line).' },
      { key: 'extraWords', label: 'Extra gestures to track', type: 'text', help: 'Series-specific gestures to add (comma-separated or one per line).' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const maxPerGesture = cfg.maxPerGesture ?? 8;
      const allowWords = splitPhraseList(cfg.allowWords);
      const extraWords = splitPhraseList(cfg.extraWords);
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      // Manuscript-wide gesture tally (an overused gesture is a whole-corpus tic,
      // not a per-issue one); track the first anchor + issue for each gesture.
      const tally = new Map(); // base → { count, anchor, issueNumber }
      const bodyParts = [];
      for (const s of sections) {
        const { gestures, bodyParts: bp } = findGestures(s?.content || '', { allowWords, extraWords });
        const { number } = sectionIssue(s);
        for (const g of gestures) {
          const cur = tally.get(g.base) || { count: 0, anchor: g.anchor, issueNumber: number };
          cur.count += 1;
          tally.set(g.base, cur);
        }
        for (const b of bp) bodyParts.push({ ...b, issueNumber: number });
      }
      // Overused-gesture findings (sorted by count, worst first).
      const overused = [...tally.entries()]
        .filter(([, v]) => v.count >= maxPerGesture)
        .sort((a, b) => b[1].count - a[1].count);
      for (const [base, info] of overused) {
        if (findings.length >= max) break;
        findings.push({
          severity: escalateSeverity(ctx.severityDefault, info.count >= maxPerGesture * 2 ? 1 : 0),
          category: 'style',
          location: info.issueNumber != null ? `Issue ${info.issueNumber}` : 'Manuscript',
          problem: `The gesture "${base}" appears about ${info.count} times across the manuscript — a repeated body-language tic readers notice.`,
          suggestion: 'Vary the beat or cut some entirely — let dialogue and context carry the emotion instead of a recurring nod/smile/shrug.',
          anchorQuote: info.anchor,
          issueNumber: info.issueNumber,
        });
      }
      // Body-part-autonomy findings (one per occurrence, capped).
      for (const b of bodyParts) {
        if (findings.length >= max) break;
        findings.push({
          severity: ctx.severityDefault,
          category: 'style',
          location: b.issueNumber != null ? `Issue ${b.issueNumber}` : 'Manuscript',
          problem: `Detached body part acting on its own ("${b.anchor}") — "body-part autonomy" reads oddly literal and is a common reader pet peeve.`,
          suggestion: 'Re-anchor the action to the character ("her eyes followed him" → "she watched him cross the room").',
          anchorQuote: b.anchor,
          issueNumber: b.issueNumber,
        });
      }
      return findings;
    },
  },
  {
    id: 'prose.word-echoes',
    sources: ['manuscript'],
    label: 'Word repetition / echoes',
    description:
      'Flags a distinctive word repeated within a short window ("obsidian… obsidian" three sentences apart) and runs of sentences that open with the same word ("He… He… He…"). Common words are ignored; only conspicuous echoes are flagged.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // How close (in words) two occurrences must be to count as an echo.
      windowWords: z.number().int().min(5).max(200).default(50),
      // Sentences in a row sharing an opener before it's flagged.
      minOpenerRun: z.number().int().min(2).max(8).default(3),
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      { key: 'windowWords', label: 'Echo window (words)', type: 'number', min: 5, max: 200, step: 5, help: 'A distinctive word repeated within this many words counts as an echo.' },
      { key: 'minOpenerRun', label: 'Repeated-opener run to flag', type: 'number', min: 2, max: 8, step: 1, help: 'How many sentences in a row starting with the same word trips the repeated-opener flag.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const windowWords = cfg.windowWords ?? 50;
      const minRun = cfg.minOpenerRun ?? 3;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const text = s?.content || '';
        const { number, location } = sectionIssue(s);
        for (const echo of findWordEchoes(text, { windowWords })) {
          if (findings.length >= max) break;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `The distinctive word "${echo.word}" repeats within ${echo.gap} words — a close echo readers notice.`,
            suggestion: 'Vary the wording or move one instance further away (close repetition of an ordinary word is invisible; a distinctive one echoes).',
            anchorQuote: echo.anchor,
            issueNumber: number,
          });
        }
        for (const run of findRepeatedOpeners(text, { minRun })) {
          if (findings.length >= max) break;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `${run.count} sentences in a row open with "${run.word}" — monotonous sentence-start rhythm ("${run.word}… ${run.word}… ${run.word}…").`,
            suggestion: 'Recast some openers — lead with a different subject, a subordinate clause, or merge sentences to break the pattern.',
            anchorQuote: run.anchor,
            issueNumber: number,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.sentence-rhythm',
    sources: ['manuscript'],
    label: 'Sentence rhythm & variety',
    description:
      'Advisory flag for monotonous sentence rhythm — when nearly every sentence in an issue is the same length (low variation in word count). Varied sentence length is what gives prose its music; a uniform cadence reads flat.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Coefficient of variation (stddev/mean of sentence lengths) at/below which
      // the rhythm is "monotonous". Lower = stricter (only the flattest passages).
      minVariation: z.number().min(0).max(1).default(0.35),
      // Don't judge rhythm on a passage shorter than this many sentences.
      minSentences: z.number().int().min(3).max(50).default(8),
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      { key: 'minVariation', label: 'Variation threshold', type: 'number', min: 0, max: 1, step: 0.05, help: 'Flag an issue whose sentence-length variation (stddev / mean) is at or below this. Lower = only the flattest, most uniform passages.' },
      { key: 'minSentences', label: 'Minimum sentences to judge', type: 'number', min: 3, max: 50, step: 1, help: 'Skip passages shorter than this many sentences (too few to judge rhythm).' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const minVariation = cfg.minVariation ?? 0.35;
      const minSentences = cfg.minSentences ?? 8;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const r = measureSentenceRhythm(s?.content || '', { minSentences });
        if (!r || r.cv > minVariation) continue;
        const { number, location } = sectionIssue(s);
        const meanRounded = Math.round(r.mean);
        findings.push({
          severity: ctx.severityDefault,
          category: 'style',
          location,
          problem: `Monotonous sentence rhythm — ${r.count} sentences averaging ${meanRounded} words with little length variation (variation ${Math.round(r.cv * 100) / 100}). A uniform cadence reads flat.`,
          suggestion: 'Vary sentence length deliberately — cut a long sentence with a short punchy one, or combine choppy sentences to build momentum.',
          anchorQuote: '',
          issueNumber: number,
        });
      }
      return findings;
    },
  },
  {
    id: 'prose.telling-emotion',
    sources: ['manuscript'],
    label: 'Telling-not-showing emotion (LLM)',
    description:
      'LLM scan for named-emotion statements ("she was sad", "he felt nervous", "they were afraid") that the prose tells rather than dramatizes. Flags strong candidates to convert to showing (action, sensation, subtext) — LLM-judged to avoid the false positives a bare keyword scan would produce.',
    scope: 'issue',
    kind: 'llm',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a long manuscript can not flood the review.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    // Localized prose-level findings (one told emotion = one spot), so this stays
    // a plain per-chunk run with no cross-chunk digest — mirrors prose.dead-metaphor.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: TELLING_EMOTION_STAGE,
      category: 'style',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'prose.dead-metaphor',
    sources: ['manuscript'],
    label: 'Dead / mixed metaphor, novel clichés & overwriting (LLM)',
    description:
      'LLM scan for tired stock language the deterministic checks miss — mixed or dead metaphors that collide or have gone invisible, novel clichés beyond the seed list, and overwrought / purple description. Complements the kill-your-darlings check (#1300) by targeting stock rather than precious prose.',
    scope: 'issue',
    kind: 'llm',
    category: 'style',
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
    // Localized prose-level findings (one tired phrase = one spot), so this stays
    // a plain per-chunk run with no cross-chunk digest — mirrors prose.info-dumping.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: DEAD_METAPHOR_STAGE,
      category: 'style',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'prose.mirror-description',
    sources: ['manuscript'],
    label: 'Mirror self-description',
    description:
      'LLM scan — flags the "character looks at themselves in a mirror/reflection to describe their own appearance" trick, a tired device for slipping a viewpoint character\'s description onto the page.',
    scope: 'issue',
    kind: 'llm',
    category: 'cliche',
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
    // Each mirror moment is a localized spot — plain per-chunk run, no digest.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: MIRROR_DESCRIPTION_STAGE,
      category: 'cliche',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'style.voice-consistency',
    sources: ['manuscript', 'series.styleGuide'],
    label: 'Narrative voice / tone consistency (LLM)',
    description:
      "LLM scan — the NARRATOR-voice sibling of dialogue.voice-distinctiveness (which covers per-character dialogue, not the narration). Fingerprints each issue's narrative tone (diction, register, humor, emotional temperature) and flags an unexplained tonal shift ACROSS issues — narration witty in issue 1, grim in issue 3, witty again in issue 5 is tonal whiplash — plus drift from the series style guide's intended voice. Does NOT flag a purposeful tonal modulation the story earns (a darker chapter a grim turn calls for). Voice consistency is part of the promise to the reader; drift reads as inconsistency. Because the comparison spans issues, the per-issue tone fingerprint is carried forward across manuscript chunks so a later issue is judged against the tone the series established.",
    scope: 'series',
    kind: 'llm',
    category: 'style',
    // Tonal drift is a polish/texture concern, so a moderate wobble floors at
    // 'low'; the prompt directs the model to mark a sharp, unexplained whiplash
    // 'medium'.
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
      // The intended-voice block is fixed per-call overhead (re-sent on each chunk)
      // and pure context: it lets the model measure each issue's narration against
      // the declared tone, not just against the other issues. The check degrades
      // gracefully — no style-guide tone ⇒ {{#intendedVoice}} renders nothing and
      // the model still flags internal cross-issue whiplash.
      const intendedVoice = intendedVoiceSummary(ctx.series?.styleGuide);
      return runManuscriptLlmCheck(ctx, {
        stage: VOICE_CONSISTENCY_STAGE,
        category: 'style',
        context: { intendedVoice },
        buildVars: (manuscript, _meta, c) => ({ manuscript, intendedVoice: c.intendedVoice }),
        // Narrator-voice consistency is a whole-series judgment: each issue's tone
        // is spread across chunks, so a per-chunk view can't tell "the series
        // shifted" from "this chunk only sampled one issue". Roll a per-issue tone
        // fingerprint forward so a later chunk judges against the tone the series
        // established (and the style guide's intent).
        crossChunkSetup: true,
        setupFocus:
          "For each issue (use the `# Issue N` section headers), capture a compact fingerprint of the NARRATOR's "
          + 'voice and tone — diction (plain vs ornate), register (formal vs casual), humor level (witty / wry / earnest / grim), '
          + 'sentence rhythm, and emotional temperature. Carry these per-issue fingerprints forward so a later issue\'s '
          + "narration can be judged against the tone the series established earlier and against the style guide's intended voice.",
      });
    },
  },
  {
    id: 'style.voice-drift',
    // Reads the style guide's voice exemplars too (#2179) so an exemplar edit
    // re-stales the finding, exactly as its LLM siblings do — the baseline can be
    // the CHOSEN voice, not just the drafted-issue mean.
    sources: ['manuscript', 'series.styleGuide'],
    label: 'Statistical voice drift (deterministic)',
    description:
      "Deterministic sibling of style.voice-consistency — where that LLM check judges tone subjectively, this MEASURES each issue's prose fingerprint (sentence rhythm, fragment/long-sentence rates, paragraph shape, dialogue ratio, em-dash rate, abstract-noun/simile density, dominant sentence-opener, plus any configured vocabulary wells), computes the series mean/σ per metric, and flags an issue that sits more than a threshold's σ from the series voice — naming the metric, the issue value vs the baseline, and the direction (\"issue 7 sentence-length CV 0.18 vs series 0.41 — prose has gone metronomic\"). It VERIFIES that the asserted voice is statistically true per issue. With the \"Drift baseline\" set to exemplars/blended it measures against the style guide's voice-exemplar profile (the CHOSEN voice) instead of the mean of what got drafted — so it flags drift from the voice you picked, not from the average of a corpus that may all have drifted together. Gates off below 4 issues drafted — with a tiny series the largest possible σ-distance (√(N−1)) can't reach the default 1.5σ threshold. No LLM cost.",
    scope: 'series',
    kind: 'deterministic',
    category: 'style',
    // A drift is a texture concern like its LLM sibling; a moderate wobble floors
    // at 'low' and a strong (≥2.5σ) outlier escalates one rank in run().
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (its per-issue `# Issue N` sections) — so the
    // runner only pays the section-collection I/O when a manuscript check is on.
    needsManuscript: true,
    configSchema: z.object({
      // How many σ from the series mean before an issue's metric is flagged.
      sigmaThreshold: z.number().min(0.5).max(4).default(1.5),
      // Minimum issues drafted before the check runs. Defaults to 4: at N=3 the
      // largest possible σ-distance is √2 ≈ 1.41, below the default 1.5σ
      // threshold, so a 3-issue series could never flag. An explicit 3 is honored
      // (useful only with a lower threshold).
      minIssues: z.number().int().min(3).max(30).default(4),
      // Cap findings per run so a wildly-uneven series can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
      // Optional vocabulary "wells" — register categories to track coverage of,
      // as `name: word, word; name2: word` (series-configurable per-check).
      vocabularyWells: z.string().max(2000).default(''),
      // Which baseline each issue's drift is measured against (#2179):
      //   drafted   — the mean of the drafted issues (default; original behavior).
      //   exemplars — the style guide's voice-exemplar profile (the CHOSEN voice),
      //               so an issue is flagged for drifting from the voice the author
      //               picked, not from the average of what got drafted.
      //   blended   — the midpoint of the two.
      // Preprocessed: any unrecognized value coerces to 'drafted' so a hand-typed
      // config can't fail the whole check's safeParse (and an exemplars/blended run
      // with no usable exemplars falls back to drafted at compute time anyway).
      baselineMode: z.preprocess(
        (v) => (VOICE_BASELINE_MODES.includes(v) ? v : 'drafted'),
        z.enum(VOICE_BASELINE_MODES),
      ).default('drafted'),
    }),
    configFields: [
      {
        key: 'sigmaThreshold',
        label: 'Drift threshold (σ)',
        type: 'number',
        min: 0.5,
        max: 4,
        step: 0.1,
        help: 'How far from the series mean (in standard deviations) an issue must sit on a metric before it is flagged. Lower = more sensitive.',
      },
      {
        key: 'minIssues',
        label: 'Minimum issues to run',
        type: 'number',
        min: 3,
        max: 30,
        step: 1,
        help: 'The check stays off until at least this many issues are drafted. It defaults to 4 because the biggest σ-distance a series of N issues can show is √(N−1), and at 3 issues that (√2 ≈ 1.41) falls below the default 1.5σ threshold — so a 3-issue series can never flag drift unless you also lower the threshold.',
      },
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings (most significant drift first) so a wildly uneven series can not flood the review.',
      },
      {
        key: 'vocabularyWells',
        label: 'Vocabulary wells (optional)',
        type: 'text',
        help: 'Register categories to track per issue, as "name: word, word; name2: word". Each becomes a tracked metric (coverage per 1k words) so a series can flag an issue that drops its trade/body/musical register.',
      },
      {
        key: 'baselineMode',
        label: 'Drift baseline',
        type: 'text',
        help: 'What each issue is measured against: "drafted" (the mean of the drafted issues — the default), "exemplars" (the style guide\'s voice-exemplar profile, so drift is judged against the voice you CHOSE, not the average of what got drafted), or "blended" (the midpoint). Exemplars/blended fall back to drafted when the style guide has too little exemplar prose.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const wells = parseVoiceWells(cfg.vocabularyWells || '');
      const drift = computeVoiceDrift(ctx.manuscript, {
        threshold: cfg.sigmaThreshold ?? 1.5,
        minIssues: cfg.minIssues ?? 4,
        wells,
        // The chosen-voice baseline (#2179): render the drift against the style
        // guide's voice exemplars when configured. A thin/absent exemplar set makes
        // computeVoiceDrift fall back to the drafted mean and report it.
        baselineMode: cfg.baselineMode || 'drafted',
        voiceExemplars: ctx.series?.styleGuide?.voiceExemplars,
      });
      if (drift.gatedOff) return [];
      const cap = cfg.maxFindings ?? 12;
      return drift.outliers.slice(0, cap).map((o) => ({
        // A strong outlier (≥2.5σ) reads as real drift, not noise — escalate it a
        // rank above the low floor; a marginal one stays low.
        severity: escalateSeverity(ctx.severityDefault, Math.abs(o.z) >= 2.5 ? 1 : 0),
        category: 'style',
        location: `Issue ${o.issue} — narrative voice`,
        problem: describeDrift(o),
        suggestion:
          `Reread Issue ${o.issue} for its ${o.label} against the rest of the series. `
          + 'If the shift is a scene the story earns (a grimmer, terser chapter), leave it; '
          + 'if it is unintentional drift, revise toward the series voice.',
        anchorQuote: null,
        issueNumber: o.issue,
      }));
    },
  },
  {
    id: 'prose.kill-your-darlings',
    sources: ['manuscript'],
    label: 'Kill your darlings (precious / self-indulgent passages)',
    description:
      'LLM scan — surfaces over-written, precious passages: a flourish, digression, or showpiece that serves the author more than the story and is a candidate to cut. Complements prose.dead-metaphor, which targets stock rather than self-indulgent prose.',
    scope: 'issue',
    kind: 'llm',
    category: 'style',
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
    // Localized prose-level findings (one precious passage = one spot) — plain
    // per-chunk run, no cross-chunk digest.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: KILL_YOUR_DARLINGS_STAGE,
      category: 'style',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'prose.adversarial-cuts',
    sources: ['manuscript'],
    label: 'Adversarial cuts (prose tightening)',
    description:
      'Asks a ruthless literary editor persona to cut 8–12% of the text, classifying each cut as FAT, REDUNDANT, OVER-EXPLAIN, GENERIC, TELL, or STRUCTURAL. Returns fat_percentage, tightest_passage (protected), loosest_passage, and typed cut findings. Safe types (OVER-EXPLAIN, REDUNDANT) can be batch-applied mechanically via the Manuscript Editor.',
    scope: 'issue',
    kind: 'llm',
    category: 'prose',
    severityDefault: 'medium',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Target percentage of text to cut (the prompt asks for this much).
      cutTargetPercent: z.number().int().min(5).max(20).default(10),
      // Minimum cuts per run.
      minCuts: z.number().int().min(5).max(30).default(10),
      // Maximum cuts per run.
      maxCuts: z.number().int().min(10).max(50).default(20),
      // Cap findings so a long manuscript can not flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      {
        key: 'cutTargetPercent',
        label: 'Cut target (%)',
        type: 'number',
        min: 5,
        max: 20,
        step: 1,
        help: 'Target percentage of the manuscript to cut. 8–12% is typical for tightening passes.',
      },
      {
        key: 'minCuts',
        label: 'Min cuts',
        type: 'number',
        min: 5,
        max: 30,
        step: 1,
        help: 'Minimum number of cut passages to identify.',
      },
      {
        key: 'maxCuts',
        label: 'Max cuts',
        type: 'number',
        min: 10,
        max: 50,
        step: 1,
        help: 'Maximum number of cut passages to identify.',
      },
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
    run: async (ctx) => {
      const cfg = ctx.config || {};
      const cutTargetPercent = cfg.cutTargetPercent ?? 10;
      const minCuts = cfg.minCuts ?? 10;
      const maxCuts = cfg.maxCuts ?? 20;
      const max = cfg.maxFindings ?? 20;
      const chunks = await ctx.planManuscriptChunks(ADVERSARIAL_CUTS_STAGE, {
        overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      });
      // Run the check with the cut parameters injected into the prompt.
      const runChunk = async (manuscript) => {
        const vars = { manuscript, cutTargetPercent, minCuts, maxCuts };
        const { content } = await ctx.callStagedLLM(ADVERSARIAL_CUTS_STAGE, vars, {
          returnsJson: true,
          source: ADVERSARIAL_CUTS_STAGE,
        });
        return content;
      };
      // Merge findings across chunks, deduping by anchorQuote.
      const seenQuotes = new Set();
      const findings = [];
      let fatPercentage = null;
      let tightestPassage = null;
      let loosestPassage = null;
      let verdict = null;
      for (const chunk of chunks?.sections || [chunks]) {
        const manuscript = typeof chunk === 'string' ? chunk : chunk?.sections?.[0]?.text || ctx.manuscript;
        const result = await runChunk(manuscript);
        // Capture meta fields from the first chunk.
        if (fatPercentage == null && typeof result?.fat_percentage === 'number') {
          fatPercentage = result.fat_percentage;
        }
        if (!tightestPassage && typeof result?.tightest_passage === 'string') {
          tightestPassage = result.tightest_passage;
        }
        if (!loosestPassage && typeof result?.loosest_passage === 'string') {
          loosestPassage = result.loosest_passage;
        }
        if (!verdict && typeof result?.one_sentence_verdict === 'string') {
          verdict = result.one_sentence_verdict;
        }
        const raw = Array.isArray(result?.findings) ? result.findings : [];
        for (const f of raw) {
          if (findings.length >= max) break;
          const anchorQuote = typeof f?.anchorQuote === 'string' ? f.anchorQuote : '';
          if (!anchorQuote || anchorQuote.length < 10) continue;
          const key = anchorQuote.toLowerCase().trim();
          if (seenQuotes.has(key)) continue;
          seenQuotes.add(key);
          const cutType = CUT_TYPES.includes(f?.cutType) ? f.cutType : null;
          findings.push({
            severity: ['high', 'medium', 'low'].includes(f?.severity) ? f.severity : ctx.severityDefault,
            category: 'prose',
            location: typeof f?.location === 'string' ? f.location : '',
            problem: typeof f?.problem === 'string' ? f.problem : '',
            suggestion: typeof f?.suggestion === 'string' ? f.suggestion : 'Cut this passage entirely.',
            anchorQuote,
            issueNumber: Number.isInteger(f?.issueNumber) ? f.issueNumber : null,
            // Carry the cut type as a subtype for filtering in the applier.
            subtype: cutType,
          });
        }
        if (findings.length >= max) break;
      }
      // Log summary for debugging.
      if (fatPercentage != null) {
        console.log(`✂️ adversarial-cuts: fat=${fatPercentage}% tightest="${(tightestPassage || '').slice(0, 40)}..." verdict="${verdict || ''}"`);
      }
      return findings;
    },
  },
  {
    id: 'prose.italic-thoughts',
    sources: ['manuscript'],
    label: 'Italicized internal thoughts',
    description:
      'Deterministic scan — flags multi-word italicized internal-thought runs ("*He knows I lied.*"). The prose is already in the character\'s perspective, so italicizing a thought is a tell; the run usually reads cleaner as plain narration. Short italic spans (a stressed word, a title, a foreign term) are left alone as emphasis.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) to anchor each run.
    needsManuscript: true,
    configSchema: z.object({
      // Minimum word count for an italic span to count as a thought (vs emphasis).
      minWords: z.number().int().min(1).max(20).default(4),
      // Cap findings per run so a thought-italics-heavy draft can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(20),
    }),
    configFields: [
      {
        key: 'minWords',
        label: 'Minimum words to flag',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        help: 'How many words an italic span must have before it is treated as an internal thought rather than emphasis. 4 skips single stressed words, titles, and foreign terms.',
      },
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a thought-italics-heavy draft can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const minWords = cfg.minWords ?? 4;
      const max = cfg.maxFindings ?? 20;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      // One finding per distinct thought run (anchored to the first issue it
      // appears in) — the same italicized thought repeated is one tic to fix.
      const seenRuns = new Set();
      for (const s of sections) {
        if (findings.length >= max) break;
        const hits = findItalicThoughts(s?.content || '', { minWords });
        for (const hit of hits) {
          if (findings.length >= max) break;
          const key = hit.inner.toLowerCase();
          if (seenRuns.has(key)) continue;
          seenRuns.add(key);
          const issueNumber = Number.isInteger(s?.number) ? s.number : null;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location: issueNumber != null ? `Issue ${issueNumber}` : 'Manuscript',
            problem: `Italicized internal thought ("${hit.anchor}") — the prose is already in the character's perspective, so italicizing a thought is a tell that usually reads cleaner as plain narration.`,
            suggestion: 'Drop the italics and let the thought stand as narration, or recast it as a beat of action/observation if it needs more grounding.',
            anchorQuote: hit.anchor,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
];
