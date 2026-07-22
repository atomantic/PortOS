/**
 * POV-continuity scene grouping + character-name dissimilarity scaffolding
 * (#2842 split of checkInfra.js).
 */

import { SEVERITIES } from './taxonomy.js';

// ---------------------------------------------------------------------------
// Chapter-ending POV switch (#1298) — deterministic over the reverse-outline POV
// map + the authored reader-map cliffhangers. The editorial rule: in a multi-POV
// story, after a chapter ends on a cliffhanger, the NEXT chapter should cut to a
// DIFFERENT POV character (the cut sustains tension across the break). The LLM
// cliffhanger check above judges WHICH endings are cliffhangers; this check uses
// the writer's AUTHORED cliffhangers as the deterministic trigger so it never
// needs the model. No authored cliffhangers ⇒ nothing to reconcile (no-op);
// single-POV series ⇒ no-op (there's no other POV to cut to).
// ---------------------------------------------------------------------------

// Group POV-tagged scenes by issue number, preserving outline (sequence) order
// within each issue and first-seen story order across issues. Scenes without an
// integer issueNumber can't be mapped to a chapter boundary and are dropped.
export function scenesByIssue(scenes) {
  const byIssue = new Map();
  for (const s of scenes) {
    if (!s || typeof s !== 'object') continue;
    const n = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    if (n == null) continue;
    if (!byIssue.has(n)) byIssue.set(n, []);
    byIssue.get(n).push(s);
  }
  return byIssue;
}

// The POV holder of a scene, trimmed, or '' when untagged.
export const scenePov = (s) => (typeof s?.povCharacter === 'string' ? s.povCharacter.trim() : '');

// The last / first POV-tagged scene of an issue's scene list (sequence-ordered),
// as { name, scene }, or null when no scene in the issue carries a POV.
export function lastPovScene(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const name = scenePov(list[i]);
    if (name) return { name, scene: list[i] };
  }
  return null;
}
export function firstPovScene(list) {
  for (const s of list) {
    const name = scenePov(s);
    if (name) return { name, scene: s };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Character-name dissimilarity (#1291) reads cast names + aliases and respects
// locked entries. The pure similarity primitives live in ./nameSimilarity.js;
// the helpers below turn the canon into the flat name list the check walks.
// ---------------------------------------------------------------------------

// SEVERITIES is ordered high→…→low (index 0 = most severe). Escalate `base` up
// by `steps` ranks, clamped at the top — a strong collision (near-identical
// spelling, dense first-letter cluster) outranks the check's low floor.
export function escalateSeverity(base, steps) {
  const i = SEVERITIES.indexOf(base);
  const idx = i === -1 ? SEVERITIES.length - 1 : i;
  return SEVERITIES[Math.max(0, idx - Math.max(0, steps))];
}

// The flat list of confusable name tokens for a cast: each character's `name`
// plus every alias, tagged with the owning character (id-or-index), whether that
// character is locked, and whether the token is an alias. Two tokens owned by the
// same character never pair (a name vs. its own alias isn't a reader collision).
export function castNameTokens(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const tokens = [];
  chars.forEach((c, idx) => {
    if (!c || typeof c !== 'object') return;
    const owner = c.id || `idx-${idx}`;
    const locked = c.locked === true;
    const primary = typeof c.name === 'string' ? c.name.trim() : '';
    if (primary) tokens.push({ token: primary, owner, ownerName: primary, locked, isAlias: false });
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    for (const a of aliases) {
      const alias = typeof a === 'string' ? a.trim() : '';
      if (alias) tokens.push({ token: alias, owner, ownerName: primary || alias, locked, isAlias: true });
    }
  });
  return tokens;
}

// A name token's display label — an alias is annotated with its owning character
// so the finding text and the rename suggestion always name the source.
export const tokenLabel = (t) => (t.isAlias ? `${t.token} (alias of ${t.ownerName})` : t.token);

// How to phrase the rename suggestion given which of the two characters are
// locked — always steer the author toward renaming an UNLOCKED one (#1291).
export function renameSuggestion(a, b) {
  if (a.locked && b.locked) {
    return `Both ${a.ownerName} and ${b.ownerName} are locked — unlock one to rename it so readers can tell them apart.`;
  }
  if (a.locked) return `Rename ${b.ownerName} (${a.ownerName} is locked) so it reads less like "${tokenLabel(a)}".`;
  if (b.locked) return `Rename ${a.ownerName} (${b.ownerName} is locked) so it reads less like "${tokenLabel(b)}".`;
  return `Rename one of ${a.ownerName} / ${b.ownerName} so readers can tell them apart at a glance.`;
}

