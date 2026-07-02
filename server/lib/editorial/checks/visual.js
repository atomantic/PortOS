// Editorial checks — visual group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  APPEARANCE_CONTINUITY_STAGE,
  EYELINE_MATCH_STAGE,
  findAxisReversals,
  findShotTypeMonotony,
  mapLlmFindings,
  summarizeStoryboardShots,
  z,
} from '../checkInfra.js';

export const visualChecks = [
  {
    id: 'visual.shot-continuity',
    sources: ['storyboard.shots'],
    label: 'Storyboard shot continuity (180° rule, shot-type variety)',
    description:
      'Flags film-grammar errors in a storyboard scene\'s shot list BEFORE render — a 180-degree-rule axis reversal across a continuity-linked shot pair (the subject appears to flip sides across a cut declared continuous), and shot-type monotony (a scene whose shots all share one framing reads as flat, slideshow coverage). Reads the per-issue storyboard shots; deterministic, so it needs no LLM.',
    scope: 'scene',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({
      // Flag a 180° axis reversal across a continuity-linked shot pair.
      flagAxisReversal: z.boolean().default(true),
      // Flag a scene where every classified shot shares one framing. 0 disables
      // the monotony check; otherwise it's the minimum classified-shot count
      // before a single-framing scene is flagged (a sparse 2-shot tag is noise).
      // The primitive floors this at 2 — a single classified shot is never
      // "monotony" — so 1 behaves identically to 2.
      minShotsForMonotony: z.number().int().min(0).max(16).default(3),
    }),
    configFields: [
      {
        key: 'flagAxisReversal',
        label: 'Flag 180° axis reversals',
        type: 'boolean',
        help: 'Flag a continuity-linked shot pair whose screen directions are opposite (left↔right) — the subject appears to jump sides across a cut the author declared continuous.',
      },
      {
        key: 'minShotsForMonotony',
        label: 'Min classified shots for monotony',
        type: 'number',
        min: 0,
        max: 16,
        step: 1,
        help: 'Flag a scene where every classified shot shares one framing (all medium, say) once at least this many shots are classified. 0 disables the monotony check; the minimum effective value is 2 (1 is treated as 2).',
      },
    ],
    // Needs at least one storyboard scene with shots to read.
    gate: (ctx) => Array.isArray(ctx.storyboardScenes) && ctx.storyboardScenes.length > 0,
    run: (ctx) => {
      const cfg = ctx.config || {};
      const flagAxis = cfg.flagAxisReversal !== false;
      const minMonotony = cfg.minShotsForMonotony ?? 3;
      const entries = Array.isArray(ctx.storyboardScenes) ? ctx.storyboardScenes : [];
      const findings = [];
      const DIRECTION_LABEL = { left: 'screen-left', right: 'screen-right', neutral: 'head-on' };
      for (const entry of entries) {
        const scene = entry?.scene;
        if (!scene || typeof scene !== 'object') continue;
        const issueNumber = Number.isInteger(entry.issueNumber) ? entry.issueNumber : null;
        const sceneName = typeof scene.heading === 'string' && scene.heading.trim()
          ? scene.heading.trim()
          : (typeof scene.slugline === 'string' && scene.slugline.trim() ? scene.slugline.trim() : 'scene');
        const location = issueNumber != null ? `Issue ${issueNumber}: ${sceneName}` : `Scene: ${sceneName}`;

        if (flagAxis) {
          for (const r of findAxisReversals(scene)) {
            const fromLabel = DIRECTION_LABEL[r.fromDirection] || r.fromDirection;
            const toLabel = DIRECTION_LABEL[r.toDirection] || r.toDirection;
            findings.push({
              severity: ctx.severityDefault,
              category: 'continuity',
              location,
              problem: `Shot "${r.toId}" continues from "${r.fromId}" but faces ${toLabel} where "${r.fromId}" faced ${fromLabel} — a 180°-rule axis reversal makes the subject appear to jump sides across the cut.`,
              suggestion: `Keep both shots on the same side of the action axis (both ${fromLabel} or both ${toLabel}), insert a neutral/head-on cutaway between them, or break the continuity link if the angle change is intentional.`,
              anchorQuote: (r.toDescription || r.fromDescription || '').slice(0, 200),
              issueNumber,
            });
          }
        }

        if (minMonotony > 0) {
          const mono = findShotTypeMonotony(scene, { minClassified: minMonotony });
          if (mono) {
            findings.push({
              severity: ctx.severityDefault,
              category: 'continuity',
              location,
              problem: `All ${mono.classifiedCount} classified shots in "${sceneName}" are ${mono.shotType} — a scene shot in a single framing reads as flat, slideshow coverage with no establishing wide or punch-in for emphasis.`,
              suggestion: `Vary the coverage: open on a wider establishing framing, punch in to a close for an emotional or key beat, or add an over-the-shoulder for a two-character exchange.`,
              anchorQuote: '',
              issueNumber,
            });
          }
        }
      }
      return findings;
    },
  },
  {
    id: 'visual.eyeline-match',
    sources: ['storyboard.shots'],
    label: 'Storyboard eyeline match (gaze continuity)',
    description:
      'LLM scan of a scene\'s storyboard shot list for eyeline-match breaks — two characters in conversation whose gaze directions don\'t reciprocate across the cut (both look the same way instead of toward each other), or a described eyeline that contradicts the shot\'s tagged screen direction. The judgment sibling of the deterministic visual.shot-continuity check (180° rule / shot-type variety): an eyeline match needs semantic reading of the free-text shot descriptions, not a vocabulary scan, so it runs an LLM over the per-issue storyboard shots. Anchors each finding to the offending shot pair.',
    scope: 'scene',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({
      // Cap findings per run so a long storyboard can't flood the review.
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
        help: 'Cap findings so a long storyboard can not flood the review.',
      },
    ],
    // Skip the LLM call entirely unless at least one scene has two-or-more
    // described shots to compare an eyeline across (mirrors the deterministic
    // sibling's storyboardScenes gate, but tightened to "comparable" scenes —
    // summarizeStoryboardShots returns '' when nothing qualifies).
    gate: (ctx) => !!summarizeStoryboardShots(ctx.storyboardScenes),
    run: async (ctx) => {
      const shots = summarizeStoryboardShots(ctx.storyboardScenes);
      if (!shots) return [];
      const { content } = await ctx.callStagedLLM(
        EYELINE_MATCH_STAGE,
        { shots },
        { returnsJson: true, source: EYELINE_MATCH_STAGE },
      );
      return mapLlmFindings(content?.findings, {
        severityDefault: ctx.severityDefault,
        category: 'continuity',
        max: ctx.config?.maxFindings ?? 12,
        // Storyboard scenes carry their source issue number (rendered into the
        // block header), so a finding keeps the model-supplied issue anchor.
        withIssueNumber: true,
      });
    },
  },
  {
    id: 'visual.appearance-continuity',
    sources: ['storyboard.shots'],
    label: 'Storyboard appearance / prop continuity',
    description:
      'LLM diff of a scene\'s storyboard shot descriptions for appearance/prop continuity breaks — the same named character described with conflicting wardrobe/hair/state across shots, a prop that appears, vanishes, or transforms with no action removing it, or a setting whose weather/time/layout contradicts across shots. The semantic sibling of the deterministic visual.shot-continuity check: the shot parser matches characters by name but never diffs their free-text descriptions, so detecting an inconsistency needs an LLM, not a vocabulary scan. Reads the per-issue storyboard shots and anchors each finding to the offending shot pair.',
    scope: 'scene',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({
      // Cap findings per run so a long storyboard can't flood the review.
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
        help: 'Cap findings so a long storyboard can not flood the review.',
      },
    ],
    // Same gate as the eyeline sibling: skip the LLM call entirely unless at least
    // one scene has two-or-more described shots to diff an appearance across
    // (summarizeStoryboardShots returns '' when nothing qualifies).
    gate: (ctx) => !!summarizeStoryboardShots(ctx.storyboardScenes),
    run: async (ctx) => {
      const shots = summarizeStoryboardShots(ctx.storyboardScenes);
      if (!shots) return [];
      const { content } = await ctx.callStagedLLM(
        APPEARANCE_CONTINUITY_STAGE,
        { shots },
        { returnsJson: true, source: APPEARANCE_CONTINUITY_STAGE },
      );
      return mapLlmFindings(content?.findings, {
        severityDefault: ctx.severityDefault,
        category: 'continuity',
        max: ctx.config?.maxFindings ?? 12,
        // Storyboard scenes carry their source issue number (rendered into the
        // block header), so a finding keeps the model-supplied issue anchor.
        withIssueNumber: true,
      });
    },
  },
];
