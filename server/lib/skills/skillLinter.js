/**
 * Advisory, non-blocking quality warnings for an authored or edited skill (`oversized-body`, `incident-log-shape`, `references-sprawl`, description checks).
 *
 * A skill should be a compact, generalizable procedure, not an incident diary:
 * these rules nudge the author (usually an agent) toward that shape. They never
 * refuse a write; `services/skills/skillService.js` returns them beside a
 * successful create/patch so the author can revise.
 */

export const SKILL_LINT_LIMITS = Object.freeze({
  MAX_BODY_CHARS: 24_000,
  MAX_REFERENCE_FILES: 60,
  MAX_INDEX_DESCRIPTION_CHARS: 120,
  // Incident narration: issue/PR numbers, dated entries and "yesterday"-style
  // anchors. Both a floor and a density keep one changelog-style mention in a
  // long procedure from tripping the rule.
  INCIDENT_MIN_MARKERS: 8,
  INCIDENT_MARKERS_PER_1000_CHARS: 2,
});

const INCIDENT_MARKER_RES = [
  /(?:^|[\s(])#\d{2,}\b/g,
  /\b(?:PR|MR|pull request)\s*#?\d+\b/gi,
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
  /\b(?:yesterday|last (?:night|week)|this morning)\b/gi,
];

const countIncidentMarkers = (text) => INCIDENT_MARKER_RES
  .reduce((total, re) => total + (text.match(re)?.length || 0), 0);

/**
 * @param {{ content: string, frontmatter?: object, referenceFileCount?: number }} input
 * @returns {{ code: string, message: string }[]}
 */
export function lintSkill({ content, frontmatter = {}, referenceFileCount = 0 }) {
  const text = typeof content === 'string' ? content : '';
  const warnings = [];
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) {
    warnings.push({ code: 'missing-description', message: 'Add a frontmatter description: the index shows only it, so a skill without one is never chosen.' });
  } else if (description.length > SKILL_LINT_LIMITS.MAX_INDEX_DESCRIPTION_CHARS) {
    warnings.push({ code: 'long-description', message: `The description is ${description.length} characters; the index shows the first ${SKILL_LINT_LIMITS.MAX_INDEX_DESCRIPTION_CHARS}. Lead with when to use the skill.` });
  }
  if (text.length > SKILL_LINT_LIMITS.MAX_BODY_CHARS) {
    warnings.push({ code: 'oversized-body', message: `SKILL.md is ${text.length} characters (over ${SKILL_LINT_LIMITS.MAX_BODY_CHARS}). Move detail into references/ files loaded on demand.` });
  }
  const markers = countIncidentMarkers(text);
  if (markers >= SKILL_LINT_LIMITS.INCIDENT_MIN_MARKERS
    && markers / Math.max(text.length / 1000, 1) >= SKILL_LINT_LIMITS.INCIDENT_MARKERS_PER_1000_CHARS) {
    warnings.push({ code: 'incident-log-shape', message: `SKILL.md reads like an incident log (${markers} issue/PR/date references). Keep the reusable lesson and drop the narration.` });
  }
  if (referenceFileCount > SKILL_LINT_LIMITS.MAX_REFERENCE_FILES) {
    warnings.push({ code: 'references-sprawl', message: `references/ holds ${referenceFileCount} files (over ${SKILL_LINT_LIMITS.MAX_REFERENCE_FILES}). Consolidate or split the skill.` });
  }
  return warnings;
}
