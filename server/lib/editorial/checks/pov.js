// Editorial checks — pov group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  HEAD_HOPPING_STAGE,
  POV_PERSON_LABELS,
  firstPovScene,
  lastPovScene,
  normalizeName,
  runManuscriptLlmCheck,
  sceneLabel,
  scenePov,
  scenePovSummary,
  scenesByIssue,
  z,
} from '../checkInfra.js';

export const povChecks = [
  {
    id: 'pov.justified',
    sources: ['reverseOutline', 'editorialArcs'],
    label: 'POV justification (every viewpoint earns its arc)',
    description:
      'Cross-references the reverse-outline POV-per-scene map against detected character arcs. Flags a POV character who narrates a viewpoint but has no arc ("POV without arc — justify or cut"), and the inverse imbalance — a drive-by POV who holds the viewpoint in only a scene or two. Falls back to the editorial analysis\'s detected arc direction until a dedicated arc model is populated, and stays silent on the no-arc check when neither is available (the structural drive-by check still runs).',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // A POV character holding the viewpoint in this many scenes or fewer is a
      // drive-by POV. 1 flags single-scene POVs; 0 disables the drive-by check.
      driveByMaxScenes: z.number().int().min(0).max(20).default(1),
      // When an arc model (detected or dedicated) is available, flag a POV
      // character whose arc is flat (no arc). Off keeps only the drive-by check.
      flagUnjustifiedPov: z.boolean().default(true),
    }),
    configFields: [
      {
        key: 'driveByMaxScenes',
        label: 'Drive-by POV threshold (max scenes)',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        help: 'Flag a POV character who holds the viewpoint in this many scenes or fewer as a drive-by POV. 1 flags single-scene POVs; 0 disables the drive-by check.',
      },
      {
        key: 'flagUnjustifiedPov',
        label: 'Flag POV characters with no arc',
        type: 'boolean',
        help: 'When a character arc model is available, flag a POV character whose detected arc is flat (no arc) — "POV without arc — justify or cut". Disable to keep only the drive-by check.',
      },
    ],
    // Needs a generated reverse outline with at least one POV-tagged scene to read.
    gate: (ctx) => Array.isArray(ctx.reverseOutline)
      && ctx.reverseOutline.some((s) => s && typeof s.povCharacter === 'string' && s.povCharacter.trim()),
    run: (ctx) => {
      const scenes = Array.isArray(ctx.reverseOutline) ? ctx.reverseOutline : [];
      const driveByMax = ctx.config?.driveByMaxScenes ?? 1;
      const flagUnjustified = ctx.config?.flagUnjustifiedPov !== false;

      // POV holder → the scenes they narrate, keyed by normalized name so casing /
      // spacing variants of the same name collapse into one holder. Preserves
      // first-appearance order (scenes arrive sequence-ordered) for stable output.
      const holders = new Map();
      for (const s of scenes) {
        if (!s || typeof s !== 'object') continue;
        const pov = typeof s.povCharacter === 'string' ? s.povCharacter.trim() : '';
        if (!pov) continue;
        const key = normalizeName(pov);
        if (!key) continue;
        let entry = holders.get(key);
        if (!entry) { entry = { name: pov, key, scenes: [] }; holders.set(key, entry); }
        entry.scenes.push(s);
      }
      if (holders.size === 0) return [];

      // Detected per-character arc directions (the #arc-transitions fallback),
      // keyed by normalized name for the holder lookup below. Trustworthiness is
      // governed by coverage completeness (canJudgeArcs), not by emptiness.
      const arcs = Array.isArray(ctx.editorialArcs) ? ctx.editorialArcs : [];
      const arcByName = new Map(
        arcs.map((a) => [normalizeName(a?.name), a]).filter(([k]) => k)
      );
      // Only cross-reference arcs when the editorial analysis is COMPLETE and
      // FRESH (every analyzable issue analyzed, none drifted — set by the runner
      // from the coverage stats). A partial batch (some issues never analyzed) or
      // a prose-staled snapshot yields unreliable arc directions: an absent holder
      // may simply be unanalyzed, and a "flat" reading may be outdated. In either
      // case we can't trust the cross-reference, so we fall back to the structural
      // drive-by check alone (graceful degradation). When coverage IS complete, an
      // empty arc set is meaningful — every POV holder genuinely lacks an arc.
      const canJudgeArcs = ctx.editorialArcsComplete === true;

      const findings = [];
      const flag = ({ severity, location, problem, suggestion, anchorQuote = '', issueNumber = null }) =>
        findings.push({ severity, category: 'arc', location, problem, suggestion, anchorQuote, issueNumber });

      for (const holder of holders.values()) {
        const sceneCount = holder.scenes.length;
        const first = holder.scenes[0];
        const issueNumber = Number.isInteger(first?.issueNumber) ? first.issueNumber : null;
        const where = issueNumber != null ? `Issue ${issueNumber}: ${sceneLabel(first)}` : `POV: ${holder.name}`;
        const anchorQuote = typeof first?.anchorQuote === 'string' ? first.anchorQuote : '';

        // 1) Unjustified POV — narrates a viewpoint but has no detected arc. Only
        //    when arcs are trustworthy (complete + fresh coverage, gated above);
        //    a holder reads "no arc" when their detected direction is flat or they
        //    don't appear in the (complete) arc set at all.
        if (flagUnjustified && canJudgeArcs) {
          const arc = arcByName.get(holder.key) || null;
          const arcIsFlat = !arc || typeof arc.arcDirection !== 'string' || arc.arcDirection === 'flat';
          if (arcIsFlat) {
            flag({
              severity: ctx.severityDefault,
              location: where,
              problem: `"${holder.name}" holds POV in ${sceneCount} scene${sceneCount === 1 ? '' : 's'} but has no detected character arc (${arc ? `arc direction is ${arc.arcDirection}` : 'not present in the detected arcs'}). A POV that exists only to deliver information — no arc, no stakes — should be cut or folded into another POV.`,
              suggestion: `Give "${holder.name}" their own arc — a want, stakes, and a change across the story — or fold their viewpoint scenes into a POV character who already has one.`,
              anchorQuote,
              issueNumber,
            });
          }
        }

        // 2) Drive-by POV (inverse imbalance) — viewpoint used in only a scene or
        //    two. Purely structural over the outline, so it runs without an arc model.
        if (driveByMax > 0 && sceneCount <= driveByMax) {
          flag({
            severity: ctx.severityDefault,
            location: where,
            problem: `"${holder.name}" holds POV in only ${sceneCount} scene${sceneCount === 1 ? '' : 's'} — a drive-by viewpoint. A POV used once reads as a structural seam (a head-hop for a single scene), diluting the viewpoints that carry the story.`,
            suggestion: `Route ${holder.name}'s scene${sceneCount === 1 ? '' : 's'} through an established POV character, or give them enough presence across the story that the viewpoint earns its place.`,
            anchorQuote,
            issueNumber,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'pov.economy',
    sources: ['reverseOutline'],
    label: 'POV economy (count vs series length, late-introduced viewpoints)',
    description:
      'Deterministic structural read of the reverse-outline POV-per-scene map at the SERIES level: flags too many viewpoints for the run length (N POV characters across M issues, each barely developed) and a POV introduced too late to earn its place (first appears in the final stretch of the run and holds only a scene or two). The acceptable POV-to-issue ratio and the late-introduction window are per-series tunable. Complements pov.justified (#1295, which asks whether each individual viewpoint earns an arc) by judging the viewpoint ROSTER as a whole. Degrades gracefully when the outline carries no issue numbers — without a series length neither signal can be judged, so the check stays silent.',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // Max POV holders per issue before the roster reads as too crowded for the
      // run length. 0.5 ≈ one viewpoint per two issues; a 12-issue run supports ~6
      // POVs, a 7th-and-up trips the check. Raise for ensemble books, lower for a
      // tight single-lead arc.
      maxPovPerIssue: z.number().min(0.05).max(10).default(0.5),
      // Don't judge POV economy on a run shorter than this many issues — a one- or
      // two-issue book is too short for a count-vs-length verdict.
      minIssues: z.number().int().min(1).max(100).default(3),
      // A POV whose FIRST appearance falls this far into the issue span (0–1) is
      // "late". 0.8 ⇒ the final fifth of the run. Only fires alongside the
      // underdevelopment guard below.
      lateIntroIssueFraction: z.number().min(0).max(1).default(0.8),
      // A late POV is flagged only when it is ALSO underdeveloped — held in this
      // many scenes or fewer. 0 disables the late-introduction check.
      lateIntroMaxScenes: z.number().int().min(0).max(50).default(2),
    }),
    configFields: [
      {
        key: 'maxPovPerIssue',
        label: 'Max POV characters per issue',
        type: 'number',
        min: 0.05,
        max: 10,
        step: 0.05,
        help: 'Flag the roster as too crowded when POV count exceeds this many viewpoints per issue. 0.5 ≈ one viewpoint every two issues (a 12-issue run supports ~6 POVs). Raise for an ensemble book, lower for a single-lead arc.',
      },
      {
        key: 'minIssues',
        label: 'Minimum issues to judge economy',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        help: 'Skip the economy verdict for a run shorter than this — too short for a count-vs-length judgment.',
      },
      {
        key: 'lateIntroIssueFraction',
        label: 'Late-introduction window (fraction of run)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        help: 'A POV whose first appearance falls this far into the issue span is "late". 0.8 = the final fifth of the run.',
      },
      {
        key: 'lateIntroMaxScenes',
        label: 'Late POV underdevelopment threshold (max scenes)',
        type: 'number',
        min: 0,
        max: 50,
        step: 1,
        help: 'Flag a late-introduced POV only when it is also underdeveloped — held in this many scenes or fewer. 0 disables the late-introduction check.',
      },
    ],
    // Needs a generated reverse outline with at least one POV-tagged scene to read.
    gate: (ctx) => Array.isArray(ctx.reverseOutline)
      && ctx.reverseOutline.some((s) => s && typeof s.povCharacter === 'string' && s.povCharacter.trim()),
    run: (ctx) => {
      const scenes = Array.isArray(ctx.reverseOutline) ? ctx.reverseOutline : [];
      const cfg = ctx.config || {};
      const maxPovPerIssue = Number.isFinite(cfg.maxPovPerIssue) ? cfg.maxPovPerIssue : 0.5;
      const minIssues = Number.isInteger(cfg.minIssues) ? cfg.minIssues : 3;
      const lateFraction = Number.isFinite(cfg.lateIntroIssueFraction) ? cfg.lateIntroIssueFraction : 0.8;
      const lateMaxScenes = Number.isInteger(cfg.lateIntroMaxScenes) ? cfg.lateIntroMaxScenes : 2;
      const severity = ctx.severityDefault || 'low';

      // 1 or 2 POV characters is never a "too many viewpoints" roster, whatever the
      // ratio — the dilution concern is fundamentally about an absolute crowd, and a
      // 2-POV / 3-issue book shares the same 0.67 ratio as the 8-POV / 12-issue book
      // the check targets. So the count signal also requires this absolute floor; the
      // ratio is the tunable, this is a structural truth (not a knob).
      const MIN_POV_TO_FLAG = 3;

      // POV holder → { name, scenes[], firstIssue }, keyed by normalized name so
      // casing/spacing variants collapse into one holder (mirrors pov.justified).
      // Preserves first-appearance order (scenes arrive sequence-ordered).
      const holders = new Map();
      const issueSet = new Set();
      for (const s of scenes) {
        if (!s || typeof s !== 'object') continue;
        const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
        if (issueNumber != null) issueSet.add(issueNumber);
        const pov = typeof s.povCharacter === 'string' ? s.povCharacter.trim() : '';
        if (!pov) continue;
        const key = normalizeName(pov);
        if (!key) continue;
        let entry = holders.get(key);
        if (!entry) { entry = { name: pov, key, scenes: [], firstIssue: issueNumber }; holders.set(key, entry); }
        entry.scenes.push(s);
        if (issueNumber != null && (entry.firstIssue == null || issueNumber < entry.firstIssue)) {
          entry.firstIssue = issueNumber;
        }
      }
      const povCount = holders.size;
      if (povCount === 0) return [];

      // Issue count drives the count-vs-length ratio AND locates "late". Without
      // issue numbers we can't judge against series length, so both signals stay
      // silent (graceful degradation — the outline rode peer sync and an older /
      // hand-edited peer may carry untagged scenes).
      const issueCount = issueSet.size;

      const findings = [];
      const flag = ({ location, problem, suggestion, anchorQuote = '', issueNumber = null }) =>
        findings.push({ severity, category: 'arc', location, problem, suggestion, anchorQuote, issueNumber });

      // 1) Too many POVs for the run length. Only when the run is long enough to
      //    judge (minIssues), the roster clears the absolute floor, and the count
      //    exceeds the configured viewpoints-per-issue budget.
      if (issueCount >= minIssues && maxPovPerIssue > 0 && povCount >= MIN_POV_TO_FLAG) {
        const budget = Math.floor(issueCount * maxPovPerIssue);
        if (povCount > budget) {
          const names = [...holders.values()].map((h) => h.name).join(', ');
          const perIssues = (1 / maxPovPerIssue).toFixed(1);
          flag({
            location: 'Series',
            problem: `${povCount} POV characters across ${issueCount} issue${issueCount === 1 ? '' : 's'} (${names}) — more viewpoints than the run length can develop. At roughly one viewpoint per ${perIssues} issues this run supports about ${budget}; each viewpoint past that gets less room and the narrative fragments.`,
            suggestion: `Consolidate viewpoints — fold the thinnest POVs into a stronger character's perspective, or cut them — until the roster fits the run (about ${budget} for ${issueCount} issues), or raise "Max POV characters per issue" if this is a deliberate ensemble.`,
          });
        }
      }

      // 2) Late-introduced, underdeveloped POV. A viewpoint whose first appearance
      //    lands in the final stretch of the run AND that holds only a scene or two
      //    never earns its place. Needs an issue span to locate "late".
      if (lateMaxScenes > 0 && issueCount >= minIssues) {
        const issues = [...issueSet];
        const minIssue = Math.min(...issues);
        const maxIssue = Math.max(...issues);
        const span = maxIssue - minIssue;
        if (span > 0) {
          for (const holder of holders.values()) {
            if (holder.firstIssue == null) continue;
            const sceneCount = holder.scenes.length;
            if (sceneCount > lateMaxScenes) continue;
            const position = (holder.firstIssue - minIssue) / span;
            if (position < lateFraction) continue;
            const first = holder.scenes[0];
            const anchorQuote = typeof first?.anchorQuote === 'string' ? first.anchorQuote : '';
            flag({
              location: `Issue ${holder.firstIssue}: ${sceneLabel(first)}`,
              problem: `"${holder.name}" first takes the viewpoint in issue ${holder.firstIssue} of ${minIssue}–${maxIssue} and holds POV in only ${sceneCount} scene${sceneCount === 1 ? '' : 's'} — a viewpoint introduced too late to develop. A fresh POV arriving in the final stretch reads as a structural seam rather than an earned perspective.`,
              suggestion: `Seed "${holder.name}"'s viewpoint earlier so it has room to pay off, route these late scenes through an established POV character, or cut the viewpoint if it exists only to deliver late information.`,
              anchorQuote,
              issueNumber: holder.firstIssue,
            });
          }
        }
      }

      return findings;
    },
  },
  {
    id: 'pov.head-hopping',
    sources: ['manuscript', 'reverseOutline', 'series.styleGuide'],
    label: 'Head-hopping / POV discipline within scenes',
    description:
      'LLM scan — in a limited-POV scene, flags narration that enters another character\'s head (reports interior thoughts/feelings the POV character can\'t know), reports knowledge or perception the POV character couldn\'t have (offstage events, things behind them), or switches POV mid-scene without a break. Anchors each finding to the POV character and names whose head was entered. Distinct from pov.justified (which asks whether each viewpoint earns an arc). No-op when the style guide sets third-person omniscient — there the wandering viewpoint is intentional.',
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
    // Skip when there's no prose, OR when the style guide declares third-person
    // omniscient — an omniscient narrator may freely roam between heads, so
    // "head-hopping" is intentional and there's nothing to police (#1311).
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0
      && ctx.series?.styleGuide?.povPerson !== 'third-omniscient',
    run: (ctx) => {
      // The POV-per-scene map is fixed per-call overhead (re-sent on each chunk).
      // It's context only — the check degrades gracefully to a whole-issue scan
      // when no reverse outline exists (the prompt's {{#povMap}} renders nothing).
      const povMap = scenePovSummary(ctx.reverseOutline);
      // Surface the configured POV person so the prompt names the discipline in
      // force (first / third-limited / second). Falls back to a neutral default
      // when unset — the check still runs (head-hopping is a problem in any
      // limited POV); only an explicit omniscient style guide no-ops via the gate.
      const povPerson = POV_PERSON_LABELS[ctx.series?.styleGuide?.povPerson]
        || 'a limited point of view';
      return runManuscriptLlmCheck(ctx, {
        stage: HEAD_HOPPING_STAGE,
        category: 'style',
        // povPerson is a short fixed label and povMap grows with scene count, so
        // largest-first trimming absorbs the cut into povMap and keeps povPerson.
        context: { povMap, povPerson },
        buildVars: (manuscript, _meta, c) => ({ manuscript, povMap: c.povMap, povPerson: c.povPerson }),
      });
    },
  },
  {
    id: 'endings.pov-switch',
    sources: ['reverseOutline', 'series.arc.readerMap'],
    label: 'Cliffhanger POV switch (multi-POV)',
    description:
      'Deterministic check over the reverse-outline POV map. In a multi-POV story, when a chapter ends on an authored cliffhanger the next chapter should cut to a DIFFERENT POV character — staying with the same viewpoint releases the tension just built. Flags each authored cliffhanger whose following chapter keeps the same POV. No-op for single-POV series and when no cliffhangers are authored.',
    scope: 'series',
    kind: 'deterministic',
    category: 'pacing',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({}),
    // Needs a reverse outline with POV-tagged scenes AND at least one authored
    // cliffhanger to reconcile against — the multi-POV no-op is decided in run().
    gate: (ctx) => Array.isArray(ctx.reverseOutline)
      && ctx.reverseOutline.some((s) => s && typeof s.povCharacter === 'string' && s.povCharacter.trim())
      && Array.isArray(ctx.series?.arc?.readerMap?.cliffhangers)
      && ctx.series.arc.readerMap.cliffhangers.length > 0,
    run: (ctx) => {
      const scenes = Array.isArray(ctx.reverseOutline) ? ctx.reverseOutline : [];
      const cliffs = Array.isArray(ctx.series?.arc?.readerMap?.cliffhangers)
        ? ctx.series.arc.readerMap.cliffhangers : [];
      if (!scenes.length || !cliffs.length) return [];

      // Multi-POV gate: a single-POV story has no other viewpoint to cut to, so
      // the "switch after a cliffhanger" rule doesn't apply — no-op (per spec).
      const povKeys = new Set();
      for (const s of scenes) {
        const key = normalizeName(scenePov(s));
        if (key) povKeys.add(key);
      }
      if (povKeys.size <= 1) return [];

      const byIssue = scenesByIssue(scenes);
      // Issue numbers in story order (Map preserves first-seen order; scenes arrive
      // sequence-ordered, so this is the chapter sequence).
      const orderedIssues = [...byIssue.keys()];
      const findings = [];
      // One finding per ending issue even if the writer logged several cliffhangers
      // at the same boundary.
      const flagged = new Set();
      for (const c of cliffs) {
        const endIssue = Number.isInteger(c?.atIssueBoundary) ? c.atIssueBoundary : null;
        if (endIssue == null || flagged.has(endIssue)) continue;
        const idx = orderedIssues.indexOf(endIssue);
        // Skip a boundary we can't resolve to an outlined issue, or one with no
        // following chapter (a cliffhanger on the last drafted chapter has nowhere
        // to cut to — and the final chapter is allowed to resolve).
        if (idx === -1 || idx === orderedIssues.length - 1) continue;
        const nextIssue = orderedIssues[idx + 1];
        // Only judge the cut when the IMMEDIATELY-following chapter is the next one
        // in the outline. If issue endIssue+1 is undrafted / not yet segmented (the
        // outline jumps to a later issue), there's no adjacent chapter to cut away
        // to — comparing across the gap would mis-attribute the cliffhanger to a
        // non-adjacent chapter, so skip (favor under-flagging).
        if (nextIssue !== endIssue + 1) continue;
        const ending = lastPovScene(byIssue.get(endIssue));
        const opening = firstPovScene(byIssue.get(nextIssue));
        if (!ending || !opening) continue;
        // POV switched across the cut — exactly what the rule wants. Nothing to flag.
        if (normalizeName(ending.name) !== normalizeName(opening.name)) continue;
        flagged.add(endIssue);
        const note = typeof c?.note === 'string' && c.note.trim() ? ` ("${c.note.trim()}")` : '';
        findings.push({
          severity: ctx.severityDefault,
          category: 'pacing',
          location: `Issue ${endIssue} → Issue ${nextIssue}`,
          problem: `Issue ${endIssue} ends on a cliffhanger${note} but Issue ${nextIssue} stays with the same POV character (${opening.name}). In a multi-POV story, holding the viewpoint straight through a cliffhanger releases the tension the cut is meant to sustain.`,
          suggestion: `Open Issue ${nextIssue} from a different POV character and return to ${opening.name}'s thread a chapter later — cutting away holds the reader on the unresolved beat.`,
          anchorQuote: typeof opening.scene?.anchorQuote === 'string' ? opening.scene.anchorQuote : '',
          issueNumber: nextIssue,
        });
      }
      return findings;
    },
  },
];
