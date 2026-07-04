// Editorial checks — deterministic "AI slop" group (#2165, CWQE Phase 1).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
// The pure detectors these checks call live in ../slopScore.js — see that
// module's doc comment for how it EXTENDS (rather than duplicates) the
// existing proseTics.js / cliches.js / repetition.js anti-slop primitives.
import {
  MIN_DENSITY_OCCURRENCES,
  countSectionBreaks,
  countWords,
  emDashDensityPer1000,
  findAiTells,
  findBannedWordsTier1,
  findStructuralTics,
  findSuspiciousWordClusters,
  paragraphLengthUniformity,
  sectionIssue,
  splitPhraseList,
  transitionOpenerRatio,
  z,
} from '../checkInfra.js';

// Problem/suggestion text per structural-tic type, keyed by the `type` field
// findStructuralTics() stamps on each hit.
const STRUCTURAL_TIC_PROBLEMS = {
  'not-just-but': (h) => `"Not just X, but Y" construction ("${h.anchor}") — the single most overused LLM rhetorical pattern.`,
  'not-saying': (h) => `"I'm not saying X, I'm saying Y" hedge-then-assert construction ("${h.anchor}").`,
  'the-way-simile': (h) => `"The way X did Y" implicit-comparison construction ("${h.anchor}") standing in for direct description.`,
  'triadic-short-sentences': (h) => `${h.count} very short sentences in a row ("${h.anchor}") — the punchy triadic-fragment rhythm LLM prose overuses.`,
  'negative-assertion-density': (h) => `${h.count} "did not [verb]" negative assertions (about ${h.density}/1000 words) — a dense run of negation reads as a rhetorical tic rather than earned tension.`,
};
const STRUCTURAL_TIC_SUGGESTIONS = {
  'not-just-but': 'State the point plainly, or vary the construction so it does not recur mechanically.',
  'not-saying': 'Cut the hedge and state the claim directly.',
  'the-way-simile': 'Replace with a direct, concrete description of the specific detail.',
  'triadic-short-sentences': 'Vary sentence length — combine some fragments or add a longer sentence to break the rhythm.',
  'negative-assertion-density': 'Show what DID happen instead of listing what did not.',
};

export const slopChecks = [
  {
    id: 'prose.slop-banned-words',
    sources: ['manuscript'],
    label: 'Tiered "AI slop" banned-word list',
    description:
      'Flags overused LLM-generation vocabulary in two tiers: Tier 1 hard-ban words ("delve", "tapestry", "myriad", "plethora", "utilize", "leverage", …) penalized per occurrence (density-scaled), and Tier 2 suspicious words ("robust", "seamless", "pivotal", …) penalized only when 3+ cluster in one paragraph — a lone Tier 2 word is ordinary prose. Deterministic word-list scan; extend or mute per house style.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Tier 1 per-1000-word rate at/above which a section is flagged.
      tier1DensityPer1000: z.number().min(0).max(50).default(3),
      // Tier 2 occurrences within one paragraph before it reads as a cluster.
      tier2ClusterThreshold: z.number().int().min(2).max(10).default(3),
      maxFindings: z.number().int().min(1).max(50).default(20),
      // House-style allowlist / extra words — applied to BOTH tiers' seed lists.
      allowWords: z.string().default(''),
      extraWords: z.string().default(''),
    }),
    configFields: [
      { key: 'tier1DensityPer1000', label: 'Tier 1 rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose Tier 1 hard-ban word frequency per 1000 words is at or above this.' },
      { key: 'tier2ClusterThreshold', label: 'Tier 2 cluster size to flag', type: 'number', min: 2, max: 10, step: 1, help: 'How many Tier 2 suspicious words within one paragraph before the cluster is flagged. A lone Tier 2 word is never flagged.' },
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a slop-heavy draft can not flood the review.' },
      { key: 'allowWords', label: 'House-style allowlist', type: 'text', help: 'Words to leave alone (comma-separated or one per line) — applies to both tiers.' },
      { key: 'extraWords', label: 'Extra banned words to flag', type: 'text', help: 'Series-specific words to add to the seed lists (comma-separated or one per line) — applies to both tiers.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const density = cfg.tier1DensityPer1000 ?? 3;
      const clusterThreshold = cfg.tier2ClusterThreshold ?? 3;
      const allowWords = splitPhraseList(cfg.allowWords);
      const extraWords = splitPhraseList(cfg.extraWords);
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];

      for (const s of sections) {
        if (findings.length >= max) break;
        const text = s?.content || '';
        const { number, location } = sectionIssue(s);

        // Tier 1 — density-scaled, one finding per offending section.
        const words = countWords(text);
        const hits = words > 0 ? findBannedWordsTier1(text, { allowWords, extraWords }) : [];
        if (hits.length) {
          const rate = Math.round((hits.length / words) * 1000 * 10) / 10;
          if (rate >= density) {
            findings.push({
              severity: ctx.severityDefault,
              category: 'style',
              location,
              problem: `${hits.length} Tier 1 "AI slop" word${hits.length === 1 ? '' : 's'} (e.g. "${hits[0].anchor}") — about ${rate}/1000 words. Words like "delve"/"myriad"/"utilize" are recognizable LLM-generation tells.`,
              suggestion: 'Replace with plain, specific vocabulary — or add intentional uses to the allowlist.',
              anchorQuote: hits[0].anchor,
              issueNumber: number,
            });
          }
        }
        if (findings.length >= max) break;

        // Tier 2 — cluster-only, one finding per clustered paragraph.
        const clusters = findSuspiciousWordClusters(text, { allowWords, extraWords, clusterThreshold });
        for (const cluster of clusters) {
          if (findings.length >= max) break;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `${cluster.count} suspicious "AI slop" words cluster in one paragraph (${cluster.anchor}) — no single word is a tell, but the density reads synthetic.`,
            suggestion: 'Vary the vocabulary — cut or replace at least one of the clustered words.',
            anchorQuote: cluster.anchor,
            issueNumber: number,
          });
        }
      }

      return findings;
    },
  },
  {
    id: 'prose.ai-tells',
    sources: ['manuscript'],
    label: 'Fiction AI-tell idioms',
    description:
      'Flags recognizable LLM-generation idioms in fiction prose — "a sense of dread", "couldn\'t help but", "eyes widened", "let out a breath she didn\'t know she\'d been holding", "a wave of relief washed over him", "heart pounded in his chest", and a physical-tell immediately re-labeled with its named emotion. Deterministic regex scan; the LLM siblings (prose.telling-emotion, prose.dead-metaphor) handle novel or judgment-dependent cases.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'medium',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      maxFindings: z.number().int().min(1).max(50).default(20),
      // Pattern ids to mute (see slopScore.js AI_TELL_PATTERNS).
      allowPatterns: z.string().default(''),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a slop-heavy draft can not flood the review.' },
      { key: 'allowPatterns', label: 'Muted AI-tell patterns', type: 'text', help: 'Pattern ids to leave alone (comma-separated or one per line): sense-of, couldnt-help-but, eyes-widened, breath-didnt-know, wave-of-emotion, heart-pounded-chest, physical-named-emotion.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const allowPatterns = splitPhraseList(cfg.allowPatterns);
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const hits = findAiTells(s?.content || '', { allowPatterns });
        const { number, location } = sectionIssue(s);
        for (const hit of hits) {
          if (findings.length >= max) break;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `${hit.label} ("${hit.anchor}") — a recognizable LLM-generation idiom.`,
            suggestion: hit.suggestion,
            anchorQuote: hit.anchor,
            issueNumber: number,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.structural-tics',
    sources: ['manuscript'],
    label: 'Structural rhetorical tics',
    description:
      'Flags rhetorical constructions LLM-generated prose overuses independent of vocabulary: "not just X, but Y", "I\'m not saying X, I\'m saying Y", a dense run of "did not [verb]" negative assertions, "the way X did Y" implicit-comparison, and runs of very short punchy sentences ("Fast. Precise. Deadly.").',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      maxFindings: z.number().int().min(1).max(50).default(20),
      // "Fast. Precise. Deadly." run detection.
      triadicMaxWords: z.number().int().min(1).max(10).default(4),
      triadicMinRun: z.number().int().min(3).max(8).default(3),
      // Per-1000-word rate of "did not [verb]" at/above which it is flagged.
      negativeAssertionDensityPer1000: z.number().min(0).max(50).default(4),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a tic-heavy draft can not flood the review.' },
      { key: 'triadicMaxWords', label: 'Short-sentence word cap', type: 'number', min: 1, max: 10, step: 1, help: 'A sentence at or under this word count counts as "short" for the triadic-run detector.' },
      { key: 'triadicMinRun', label: 'Short sentences in a row to flag', type: 'number', min: 3, max: 8, step: 1, help: 'How many consecutive short sentences trip the "Fast. Precise. Deadly." flag.' },
      { key: 'negativeAssertionDensityPer1000', label: '"Did not" rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose "did not [verb]" / "didn\'t [verb]" frequency per 1000 words is at or above this.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const opts = {
        maxWords: cfg.triadicMaxWords ?? 4,
        minRun: cfg.triadicMinRun ?? 3,
        negativeAssertionDensityPer1000: cfg.negativeAssertionDensityPer1000 ?? 4,
      };
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const tics = findStructuralTics(s?.content || '', opts);
        const { number, location } = sectionIssue(s);
        for (const t of tics) {
          if (findings.length >= max) break;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: STRUCTURAL_TIC_PROBLEMS[t.type](t),
            suggestion: STRUCTURAL_TIC_SUGGESTIONS[t.type],
            anchorQuote: t.anchor,
            issueNumber: number,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.burstiness',
    sources: ['manuscript'],
    label: 'Structural burstiness (em-dash / transitions / paragraphs / scene breaks)',
    description:
      'Flags the quantitative structural signals of synthetic uniformity: em-dash overuse, a high rate of essay-style transition-word sentence openers ("However, … Moreover, … Ultimately, …"), runs of paragraphs with near-identical word counts, and an over-fragmented rate of scene/section breaks. Deliberately separate from prose.sentence-rhythm (sentence-length variation, already deterministic there) so the two never double-report the same anchor — this module\'s sentence-length CV signal is folded only into the deterministic slop-score composite (slopScore.js computeSlopPenalty), never reported as its own finding here.',
    scope: 'issue',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      maxFindings: z.number().int().min(1).max(50).default(20),
      emDashThresholdPer1000: z.number().min(0).max(100).default(15),
      transitionRatioThreshold: z.number().min(0).max(1).default(0.3),
      paragraphUniformityMinRun: z.number().int().min(3).max(10).default(3),
      sectionBreakThresholdPer1000: z.number().min(0).max(50).default(8),
    }),
    configFields: [
      { key: 'maxFindings', label: 'Max findings per run', type: 'number', min: 1, max: 50, step: 1, help: 'Cap findings so a heavy draft can not flood the review.' },
      { key: 'emDashThresholdPer1000', label: 'Em-dash rate to flag (per 1000 words)', type: 'number', min: 0, max: 100, step: 1, help: 'Flag a section whose em-dash frequency per 1000 words is at or above this.' },
      { key: 'transitionRatioThreshold', label: 'Transition-opener ratio to flag', type: 'number', min: 0, max: 1, step: 0.05, help: 'Flag a section where more than this fraction of sentences open with an essay-style transition word.' },
      { key: 'paragraphUniformityMinRun', label: 'Uniform paragraphs in a row to flag', type: 'number', min: 3, max: 10, step: 1, help: 'How many consecutive similar-length paragraphs trip the mechanical-cadence flag.' },
      { key: 'sectionBreakThresholdPer1000', label: 'Scene-break rate to flag (per 1000 words)', type: 'number', min: 0, max: 50, step: 1, help: 'Flag a section whose scene/section-break marker frequency per 1000 words is at or above this — over-fragmented pacing.' },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const max = cfg.maxFindings ?? 20;
      const emDashThreshold = cfg.emDashThresholdPer1000 ?? 15;
      const transitionThreshold = cfg.transitionRatioThreshold ?? 0.3;
      const uniformityMinRun = cfg.paragraphUniformityMinRun ?? 3;
      const sectionBreakThreshold = cfg.sectionBreakThresholdPer1000 ?? 8;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const findings = [];
      for (const s of sections) {
        if (findings.length >= max) break;
        const text = s?.content || '';
        const words = countWords(text);
        const { number, location } = sectionIssue(s);

        const emDash = emDashDensityPer1000(text);
        if (findings.length < max && emDash.count >= MIN_DENSITY_OCCURRENCES && emDash.rate >= emDashThreshold) {
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `Em-dash rate of ${emDash.rate}/1000 words (${emDash.count} total) — a heavy em-dash reliance reads as a mechanical punctuation crutch.`,
            suggestion: 'Recast some em-dash breaks as separate sentences, commas, or parentheticals to vary the punctuation texture.',
            anchorQuote: '',
            issueNumber: number,
          });
        }

        const transitions = transitionOpenerRatio(text);
        if (findings.length < max && transitions.total > 0 && transitions.ratio > transitionThreshold) {
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `${transitions.count} of ${transitions.total} sentences (${Math.round(transitions.ratio * 100)}%) open with an essay-style transition word (e.g. "${transitions.anchor}") — reads as signposting rather than fiction's momentum.`,
            suggestion: 'Cut most transition openers and let the prose\'s own causality carry the connection.',
            anchorQuote: transitions.anchor,
            issueNumber: number,
          });
        }

        if (findings.length < max && words > 0) {
          const breaks = countSectionBreaks(text);
          const breakRate = Math.round((breaks / words) * 1000 * 10) / 10;
          if (breaks > 0 && breakRate >= sectionBreakThreshold) {
            findings.push({
              severity: ctx.severityDefault,
              category: 'style',
              location,
              problem: `${breaks} scene/section breaks (about ${breakRate}/1000 words) — an over-fragmented rate of breaks reads as choppy, mechanical pacing.`,
              suggestion: 'Consolidate some scenes, or replace a hard break with a transitional paragraph.',
              anchorQuote: '',
              issueNumber: number,
            });
          }
        }

        for (const run of paragraphLengthUniformity(text, { minRun: uniformityMinRun })) {
          if (findings.length >= max) break;
          findings.push({
            severity: ctx.severityDefault,
            category: 'style',
            location,
            problem: `${run.count} consecutive paragraphs averaging ${run.avgWords} words each with little variation — a mechanically uniform paragraph cadence.`,
            suggestion: 'Vary paragraph length deliberately — break a long paragraph or combine a few short ones.',
            anchorQuote: run.anchor,
            issueNumber: number,
          });
        }
      }
      return findings;
    },
  },
];
