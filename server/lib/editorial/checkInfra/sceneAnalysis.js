/**
 * Reverse-outline scene analytics (#2842 split of checkInfra.js): component mix,
 * grounding, plotline coverage, conflict-intensity tally, POV distribution and
 * secondary-character presence.
 */

import { normalizeName } from './externals.js';
import { scenePov } from './povAndNames.js';

// ---------------------------------------------------------------------------
// Scene component balance (#1296) — reads the cached reverse-outline (#1286)
// scene segmentation, where each scene carries a `components` boolean signal
// { narrative, action, dialogue }. The editorial rule: a scene should mix at
// least 2 of the 3; a single-mode scene (a narration wall, talking heads with
// no action, pure action with no interiority or voice) reads flat and is flagged.
//
// A scene with NO component flagged (all three false) is treated as
// "unclassified" (an older outline, or a scene the segmenter didn't tag), not
// "zero components" — it is skipped rather than flagged as a false positive,
// per the absent-vs-empty rule.
// ---------------------------------------------------------------------------

const SCENE_COMPONENT_KEYS = ['narrative', 'action', 'dialogue'];

// The present/missing component lists for a scene's `components` signal.
export function sceneComponentMix(components) {
  const c = components && typeof components === 'object' ? components : {};
  const present = SCENE_COMPONENT_KEYS.filter((k) => c[k] === true);
  const missing = SCENE_COMPONENT_KEYS.filter((k) => c[k] !== true);
  return { present, missing };
}

// A scene's display label for finding text/location — its heading, falling back
// to the summary, then a sequence-based label. Type-guarded because the reverse
// outline rides peer sync (#1348): a hand-edited / older-peer scene could carry a
// non-string heading, and a bare `.trim()` on it would throw and abort the check.
export const sceneLabel = (s) => {
  const heading = typeof s?.heading === 'string' ? s.heading.trim() : '';
  const summary = typeof s?.summary === 'string' ? s.summary.trim() : '';
  const seq = typeof s?.sequence === 'number' ? s.sequence + 1 : '?';
  return heading || summary || `scene ${seq}`;
};

// Render the reverse-outline scenes into a compact text block the scene-grounding
// LLM checks (#1309) pass alongside the manuscript so the model can attribute
// findings to scenes and reason about each scene's recorded setting / characters.
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' when there are no scenes (the prompt's
// `{{#sceneMap}}` section then renders nothing and the check degrades to a plain
// whole-issue manuscript scan). Type-guarded throughout — the reverse outline
// rides peer sync (#1348), so a hand-edited / older-peer scene could carry a
// non-string field that a bare `.trim()` would throw on.
export function sceneGroundingSummary(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const lines = list.map((s) => {
    if (!s || typeof s !== 'object') return '';
    const label = sceneLabel(s);
    const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    const where = issueNumber != null ? `Issue ${issueNumber}` : 'Scene';
    const setting = typeof s.setting === 'string' ? s.setting.trim() : '';
    const chars = Array.isArray(s.charactersPresent)
      ? s.charactersPresent.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [];
    const parts = [`- ${where}: ${label}`];
    parts.push(setting ? `setting: ${setting}` : 'setting: (none recorded)');
    if (chars.length) parts.push(`present: ${chars.join(', ')}`);
    return parts.join(' — ');
  }).filter(Boolean);
  if (!lines.length) return '';
  return `Scenes (from the reverse outline):\n${lines.join('\n')}`;
}

// Render the reverse-outline PLOTLINES (#1286) into a compact text block the
// plot-structure check (#1310) passes alongside the manuscript so the model can
// reconcile dropped subplots against the author's tagged plotlines — a plotline
// that opens early and is never returned to is a dropped subplot. For each
// plotline we count the scenes tagged to it (primary OR secondary) and report the
// span of issues those scenes touch, so the model sees which threads fizzle.
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' when there are no plotlines (the
// prompt's `{{#plotlineMap}}` section then renders nothing and the check degrades
// to reasoning about subplots from the prose alone). Type-guarded throughout —
// the reverse outline rides peer sync (#1348), so a hand-edited / older-peer
// plotline could carry a non-string field a bare `.trim()` would throw on.
export function plotlineCoverageSummary(plotlines, scenes) {
  const lines = Array.isArray(plotlines) ? plotlines : [];
  const sceneList = Array.isArray(scenes) ? scenes : [];
  const rows = lines.map((pl) => {
    if (!pl || typeof pl !== 'object') return '';
    const id = typeof pl.id === 'string' ? pl.id : '';
    if (!id) return '';
    const label = typeof pl.label === 'string' && pl.label.trim() ? pl.label.trim() : id;
    const kind = typeof pl.kind === 'string' && pl.kind.trim() ? pl.kind.trim() : 'other';
    // Scenes tagged to this plotline (primary or secondary), in outline order.
    const tagged = sceneList.filter((s) => s && (s.plotlineId === id || s.secondaryPlotlineId === id));
    const issues = [...new Set(
      tagged
        .map((s) => (Number.isInteger(s.issueNumber) ? s.issueNumber : null))
        .filter((n) => n != null),
    )].sort((a, b) => a - b);
    const span = issues.length
      ? (issues.length === 1 ? `issue ${issues[0]}` : `issues ${issues[0]}–${issues[issues.length - 1]}`)
      : 'no tagged scenes';
    return `- ${label} (${kind}): ${tagged.length} scene${tagged.length === 1 ? '' : 's'}, ${span}`;
  }).filter(Boolean);
  if (!rows.length) return '';
  return `Plotlines (from the reverse outline — reconcile dropped subplots against these):\n${rows.join('\n')}`;
}

// Curated lexicon of conflict / stakes / high-intensity markers (#1618). A
// per-issue tally of these words is a crude-but-deterministic proxy for dramatic
// intensity: the escalation-curve check can't "feel" tension, but it CAN see
// whether the density of conflict language rises, plateaus, or falls across the
// issues. The model treats the tally as a hint (not ground truth) and confirms
// the curve against the prose — so a quiet-but-tense scene the lexicon misses is
// still caught. Word-boundary matched, case-insensitive; kept deliberately small
// and high-signal (physical conflict + danger/stakes) to limit false hits.
const CONFLICT_INTENSITY_MARKERS = Object.freeze([
  // physical conflict / violence
  'attack', 'attacks', 'attacked', 'fight', 'fights', 'fought', 'fighting',
  'strike', 'strikes', 'struck', 'punch', 'punched', 'stab', 'stabbed', 'shoot',
  'shoots', 'shot', 'kill', 'kills', 'killed', 'die', 'dies', 'died', 'death',
  'blood', 'bleeding', 'wound', 'wounded', 'scream', 'screams', 'screamed',
  'shout', 'shouted', 'slam', 'slammed', 'crash', 'crashed',
  // danger / stakes / dread
  'danger', 'dangerous', 'threat', 'threats', 'threaten', 'threatened', 'enemy',
  'enemies', 'weapon', 'weapons', 'gun', 'guns', 'knife', 'fire', 'fired',
  'fires', 'firing', 'explode', 'exploded', 'explosion', 'fear', 'terror',
  'panic', 'desperate', 'betray',
  'betrayed', 'betrayal', 'trap', 'trapped', 'flee', 'fled', 'chase', 'chased',
  'escape', 'war', 'battle', 'dying', 'doom', 'doomed',
]);

// Tally the conflict-marker density per issue across the WHOLE stitched manuscript
// (#1618) so the escalation-curve check sees the complete intensity shape on every
// chunk. Splits on the `# Issue N` headers the manuscript stitcher emits, counts
// markers + words per issue, and reports markers-per-1k-words — normalizing out
// raw length so a long-but-quiet issue doesn't read as more intense than a short
// climactic one. Pure + deterministic so it's unit-testable and its token cost can
// be counted into the per-chunk overhead. Returns '' when there are no issue
// headers (the prompt's `{{#intensityTally}}` section then renders nothing and the
// check judges the curve from the prose + scene map alone). A header that repeats
// across the stitch (a chunk boundary mid-issue) sums into the same issue bucket.
export function conflictIntensityTally(manuscript) {
  const text = typeof manuscript === 'string' ? manuscript : '';
  if (!text.trim()) return '';
  const headerRe = /^#+\s*Issue\s+(\d+)\b[^\n]*$/gim;
  const sections = [];
  let match;
  let prev = null;
  while ((match = headerRe.exec(text)) !== null) {
    if (prev) prev.end = match.index;
    prev = { issue: Number(match[1]), start: headerRe.lastIndex, end: text.length };
    sections.push(prev);
  }
  if (!sections.length) return '';
  const markerRe = new RegExp(`\\b(?:${CONFLICT_INTENSITY_MARKERS.join('|')})\\b`, 'gi');
  // Sum duplicate issue numbers (a repeated header across a stitch) — keep numeric
  // order so the rendered curve reads issue 1 → N for the model.
  const byIssue = new Map();
  for (const sec of sections) {
    const body = text.slice(sec.start, sec.end);
    const words = (body.match(/\b[\w']+\b/g) || []).length;
    const markers = (body.match(markerRe) || []).length;
    const acc = byIssue.get(sec.issue) || { words: 0, markers: 0 };
    byIssue.set(sec.issue, { words: acc.words + words, markers: acc.markers + markers });
  }
  const rows = [...byIssue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([issue, { words, markers }]) => {
      const density = words > 0 ? (markers / words) * 1000 : 0;
      return `- Issue ${issue}: ${markers} conflict marker${markers === 1 ? '' : 's'} across `
        + `${words} word${words === 1 ? '' : 's'} (${density.toFixed(1)} per 1k)`;
    });
  if (!rows.length) return '';
  return 'Conflict-marker density per issue (deterministic intensity proxy — a rising '
    + 'number suggests escalation, a flat or falling one a plateau / de-escalation; '
    + 'treat as a hint and confirm against the prose):\n' + rows.join('\n');
}

// Human-readable POV-person labels for the head-hopping check's prompt (#1311).
// Inlined (not imported from styleGuide.js) to keep this registry pure — mirrors
// the labels in server/lib/styleGuide.js so generation and the check describe a
// POV person identically. An omniscient style guide no-ops via the check's gate,
// so it's intentionally absent here.
export const POV_PERSON_LABELS = Object.freeze({
  first: 'first person',
  'third-limited': 'third-person limited',
  second: 'second person',
});

// Render the reverse-outline scenes into a compact POV-focused block the
// head-hopping check (#1311) passes alongside the manuscript so the model knows
// WHOSE head each limited-POV scene is anchored to — and which other characters
// are on-stage (candidate heads a head-hop would slip into). EVERY scene is
// rendered: a scene with no recorded POV character is marked "POV: (not recorded
// — infer from the prose)" rather than dropped, so a PARTIALLY-tagged outline
// doesn't silently omit scenes and let the model assume the list is exhaustive of
// POV-bearing scenes (the model still confirms each anchor against the prose).
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' only when there are NO scenes at all
// (the prompt's `{{#povMap}}` section then renders nothing and the check degrades
// to a plain whole-issue scan). Type-guarded throughout — the reverse outline
// rides peer sync (#1348), so a hand-edited / older-peer scene could carry a
// non-string field that a bare `.trim()` would throw on.
export function scenePovSummary(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const lines = list.map((s) => {
    if (!s || typeof s !== 'object') return '';
    const label = sceneLabel(s);
    const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    const where = issueNumber != null ? `Issue ${issueNumber}` : 'Scene';
    const pov = scenePov(s);
    // Other on-stage characters are the candidate heads a head-hop slips into —
    // exclude the POV holder themselves (by normalized name) so the list names
    // only "other" heads. When the scene has no recorded POV holder there's no
    // one to exclude, so every present character is a candidate.
    const povKey = pov ? normalizeName(pov) : '';
    const others = Array.isArray(s.charactersPresent)
      ? s.charactersPresent
        .filter((n) => typeof n === 'string' && n.trim() && normalizeName(n) !== povKey)
        .map((n) => n.trim())
      : [];
    const povText = pov ? `POV: ${pov}` : 'POV: (not recorded — infer from the prose)';
    const parts = [`- ${where}: ${label} — ${povText}`];
    if (others.length) parts.push(`others present: ${others.join(', ')}`);
    return parts.join(' — ');
  }).filter(Boolean);
  if (!lines.length) return '';
  return `POV per scene (from the reverse outline):\n${lines.join('\n')}`;
}

// Render the RECURRING NON-POV cast (#1585) into a compact text block the
// secondary-arc check passes alongside the manuscript, so the model focuses on
// the side characters that actually carry weight (present across multiple scenes)
// rather than every walk-on. A "secondary" character is one who appears in
// `charactersPresent` but NEVER holds `povCharacter` in ANY scene — a character
// who ever takes the viewpoint is a POV character (covered by pov.justified). For
// each such character we count the scenes they appear in and the span of issues
// those scenes touch, keeping only those at or above `minScenes` (the recurrence
// threshold). Pure + deterministic so it's unit-testable and its token cost can
// be counted into the per-chunk overhead. Returns '' when no non-POV character
// recurs enough (the prompt's `{{#secondaryCast}}` section then renders nothing
// and the check degrades to identifying recurring side characters from the prose
// alone). Type-guarded throughout — the reverse outline rides peer sync (#1348),
// so a hand-edited / older-peer scene could carry a non-string field a bare
// `.trim()` would throw on.
export function secondaryCharacterPresenceSummary(scenes, { minScenes = 2 } = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const threshold = Number.isInteger(minScenes) && minScenes > 0 ? minScenes : 2;

  // Every character who EVER holds the viewpoint, by normalized name — these are
  // POV characters and are excluded from the secondary cast even in scenes where
  // they happen to be present-but-not-narrating.
  const povHolders = new Set();
  for (const s of list) {
    const pov = scenePov(s);
    if (pov) povHolders.add(normalizeName(pov));
  }

  // Non-POV character → { name, sceneCount, issues } keyed by normalized name so
  // casing / spacing variants collapse. Preserves first-appearance order (scenes
  // arrive sequence-ordered) for stable output.
  const cast = new Map();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    const present = Array.isArray(s.charactersPresent)
      ? s.charactersPresent.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [];
    // De-dup names within a single scene so a name listed twice counts once.
    const seenThisScene = new Set();
    for (const name of present) {
      const key = normalizeName(name);
      if (!key || povHolders.has(key) || seenThisScene.has(key)) continue;
      seenThisScene.add(key);
      let entry = cast.get(key);
      if (!entry) { entry = { name, sceneCount: 0, issues: new Set() }; cast.set(key, entry); }
      entry.sceneCount += 1;
      if (issueNumber != null) entry.issues.add(issueNumber);
    }
  }

  const rows = [];
  for (const entry of cast.values()) {
    if (entry.sceneCount < threshold) continue;
    const issues = [...entry.issues].sort((a, b) => a - b);
    const span = issues.length
      ? (issues.length === 1 ? `issue ${issues[0]}` : `issues ${issues[0]}–${issues[issues.length - 1]}`)
      : 'no tagged issues';
    rows.push(`- ${entry.name}: present in ${entry.sceneCount} scene${entry.sceneCount === 1 ? '' : 's'} (${span})`);
  }
  if (!rows.length) return '';
  return `Recurring non-POV characters (appear in ${threshold}+ scenes but never hold POV — judge whether each shows meaningful change):\n${rows.join('\n')}`;
}

