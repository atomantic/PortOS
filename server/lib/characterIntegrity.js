/**
 * The shared cast-integrity contract (#6415).
 *
 * "Every field is filled" and "this character holds together" are different
 * questions, and until now only the first had an answer. `missingBibleFields`
 * counts blanks; `applyExpansion` fills blanks; neither can say that a fully
 * populated profile states a control belief its own behavior contradicts, or
 * that its three drives are the same sentence written three ways.
 *
 * This module is the vocabulary both questions report in, so one report shape
 * reaches every consumer instead of each surface inventing its own:
 *
 *   - the deterministic pass (`castCompletenessFindings`) — NO provider calls,
 *     safe to run on every load
 *   - the semantic pass (`mergeSemanticFindings`) — an explicitly invoked LLM
 *     review, validated back into the same finding shape
 *
 * PURE: shape, predicates and merges only. No storage, no provider I/O, no
 * universe/series/work concepts — the callers own those, which is what lets
 * Universe Bible, Series, FableLoom and Writers Room share one contract.
 *
 * The vocabulary itself — finding kinds, review statuses, depths, the five
 * semantic dimensions and `castIntegrityPassed` — lives in
 * `characterIntegrityVocabulary.js`, a browser-safe leaf the report UI imports
 * directly; this module reaches Node built-ins through `storyBible.js`.
 *
 * Reports are DERIVED, never persisted, so `characterFingerprint` is what keeps
 * a repair honest: a proposal carries the fingerprint of the character it was
 * reviewed against, and applying it to a record that has since changed is
 * refused rather than silently overwriting the newer edit.
 */

import {
  CHARACTER_FRAMEWORK_TEXT_FIELDS,
} from './characterFramework.js';
import {
  bibleFieldIsBlank,
  characterPsychologyIsBlank,
} from './universeBibleCompleteness.js';
import { PSYCHOLOGY_DRIVE_AXES } from './storyBible.js';
import { INTEGRITY_DIMENSION_IDS, INTEGRITY_FINDING_KINDS } from './characterIntegrityVocabulary.js';
import { isEmptyScalar } from './objects.js';

const FINDING_KIND_SET = new Set(INTEGRITY_FINDING_KINDS);
const DIMENSION_ID_SET = new Set(INTEGRITY_DIMENSION_IDS);

/**
 * The framework fields the deterministic pass measures, in report order.
 * Sourced from `characterFramework.js` plus the psychology profile so a field
 * added there is measured here without a second edit.
 *
 * `relationshipLinks` is deliberately absent: it is authored by picking a
 * sibling entry, and a solo character legitimately has none. The
 * `relationships-pressure` DIMENSION still asks about it semantically — the
 * difference is that a human/model judges whether the pressure is meaningful,
 * where a blank-count would just call every hermit incomplete.
 */
export const INTEGRITY_FIELDS = Object.freeze([...CHARACTER_FRAMEWORK_TEXT_FIELDS, 'psychology']);

/** Fields each depth actually asks for. `explained` asks for none. */
const DEPTH_FIELDS = Object.freeze({
  explained: Object.freeze([]),
  light: Object.freeze(['motivations', 'want']),
  full: INTEGRITY_FIELDS,
});

/**
 * Roles that read as "this character is scenery" — matched as whole words on a
 * lowercased role so "extra" doesn't fire on "extraordinary". Deliberately
 * short: the cost of missing one is a full-depth report on a bit player (noisy
 * but correct), while the cost of over-matching is silently excusing a lead.
 */
const MINOR_ROLE_WORDS = Object.freeze([
  'minor', 'background', 'extra', 'cameo', 'walk-on', 'bit', 'incidental',
]);

const roleIsMinor = (role) => {
  if (typeof role !== 'string') return false;
  const words = role.toLowerCase().split(/[^a-z-]+/).filter(Boolean);
  return words.some((w) => MINOR_ROLE_WORDS.includes(w));
};

/**
 * Which depth applies to one character. Exported so a UI can explain WHY a
 * character was held to a lighter standard instead of looking inconsistent.
 */
export function characterIntegrityDepth(entry) {
  if (!entry || typeof entry !== 'object') return 'light';
  const assessment = entry.psychology?.assessment;
  if ((assessment === 'unknown' || assessment === 'not-applicable')
    && !isEmptyScalar(entry.psychology?.assessmentNote)) {
    return 'explained';
  }
  if (roleIsMinor(entry.role) || entry.arcType === 'flat') return 'light';
  return 'full';
}

/** The dimensions worth asking about a character at its depth. */
export function characterIntegrityDimensions(entry) {
  const depth = characterIntegrityDepth(entry);
  if (depth === 'explained') return [];
  if (depth === 'light') return ['control-predicts-behavior', 'challenge-testable'];
  return INTEGRITY_DIMENSION_IDS;
}

const findingId = (characterId, kind, field) => `${characterId}::${kind}::${field}`;

/**
 * One finding, normalized. Every finding — deterministic or model-authored —
 * has the same shape so a consumer never branches on where it came from.
 */
const makeFinding = ({
  characterId, characterName, kind, field, evidence, suggestion, dimension,
}) => ({
  id: findingId(characterId, kind, field),
  characterId,
  characterName: characterName || '',
  kind,
  // Dotted path into the character record — `psychology.drives.status.fear`,
  // not just `psychology` — so an editor can focus the exact input.
  field,
  dimension: dimension || null,
  evidence: evidence || '',
  suggestion: suggestion || '',
});

/**
 * Deterministic gaps on ONE character. No provider, no judgement — a field
 * this reports is genuinely empty, which is why it can run on every load.
 *
 * `psychology` expands into its leaves rather than reporting one opaque gap:
 * "the profile is unfilled" is not actionable, "the status drive has no fear"
 * is. The leaf walk only runs once the profile is partly authored — an
 * untouched character reports the single `psychology` gap instead of nine.
 */
export function characterCompletenessFindings(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const depth = characterIntegrityDepth(entry);
  const fields = DEPTH_FIELDS[depth] || DEPTH_FIELDS.full;
  const findings = [];
  const base = { characterId: entry.id, characterName: entry.name, kind: 'missing' };
  for (const field of fields) {
    if (field !== 'psychology') {
      if (bibleFieldIsBlank(entry, field)) {
        findings.push(makeFinding({ ...base, field, evidence: `\`${field}\` is empty.` }));
      }
      continue;
    }
    if (!characterPsychologyIsBlank(entry.psychology)) continue;
    // Nothing authored at all — one gap, not a wall of them.
    if (!entry.psychology || typeof entry.psychology !== 'object') {
      findings.push(makeFinding({
        ...base,
        field: 'psychology',
        evidence: 'No theory of control or drives authored.',
      }));
      continue;
    }
    if (isEmptyScalar(entry.psychology.theoryOfControl)) {
      findings.push(makeFinding({
        ...base,
        field: 'psychology.theoryOfControl',
        evidence: 'No control belief stated, so nothing predicts this behavior.',
      }));
    }
    for (const axis of PSYCHOLOGY_DRIVE_AXES) {
      for (const leaf of ['desire', 'fear']) {
        if (!isEmptyScalar(entry.psychology.drives?.[axis]?.[leaf])) continue;
        findings.push(makeFinding({
          ...base,
          field: `psychology.drives.${axis}.${leaf}`,
          evidence: `The ${axis} drive has no ${leaf}.`,
        }));
      }
    }
  }
  return findings;
}

/**
 * A content fingerprint of the fields a report is measured against.
 *
 * Deliberately narrow: only the integrity fields plus role/arcType (which pick
 * the depth) and the relationship targets (which the pressure dimension reads).
 * A wardrobe edit or a re-render must NOT invalidate a review that had nothing
 * to do with it — a fingerprint over the whole record would make every report
 * stale on the next image job.
 */
export function characterFingerprint(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [entry.id || '', entry.role || '', entry.arcType || ''];
  for (const field of CHARACTER_FRAMEWORK_TEXT_FIELDS) {
    parts.push(typeof entry[field] === 'string' ? entry[field].trim() : '');
  }
  const p = entry.psychology;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    parts.push(
      p.theoryOfControl || '', p.strategy || '', p.protectiveBenefit || '',
      p.presentCost || '', p.testingPressure || '', p.candidateChange || '',
      p.assessment || '', p.assessmentNote || '',
    );
    for (const axis of PSYCHOLOGY_DRIVE_AXES) {
      parts.push(p.drives?.[axis]?.desire || '', p.drives?.[axis]?.fear || '');
    }
  }
  const links = Array.isArray(entry.relationshipLinks) ? entry.relationshipLinks : [];
  for (const link of links) parts.push(`${link?.targetCharacterId || ''}:${link?.type || ''}`);
  // Length-prefixed join: a `|` inside an authored field can't forge a
  // boundary and make two different casts fingerprint the same.
  return parts.map((s) => `${String(s).length}:${s}`).join('|');
}

/**
 * Build the deterministic report for a cast.
 *
 * `characterIds` scopes the pass; every character outside it is still LISTED,
 * with status `not-reviewed`. That is the coverage contract — the caller can
 * always tell "no findings" apart from "never looked".
 */
export function buildCastIntegrityReport(characters, { characterIds = null } = {}) {
  const cast = Array.isArray(characters) ? characters.filter((c) => c?.id) : [];
  const scope = characterIds ? new Set(characterIds) : null;
  const findings = [];
  const coverage = cast.map((entry) => {
    const inScope = !scope || scope.has(entry.id);
    if (!inScope) {
      return {
        characterId: entry.id,
        characterName: entry.name || '',
        depth: characterIntegrityDepth(entry),
        status: 'not-reviewed',
        findingCount: 0,
        semanticReviewed: false,
      };
    }
    const own = characterCompletenessFindings(entry);
    findings.push(...own);
    return {
      characterId: entry.id,
      characterName: entry.name || '',
      depth: characterIntegrityDepth(entry),
      status: own.length ? 'findings' : 'passed',
      findingCount: own.length,
      // The deterministic pass alone never counts as a semantic review — a
      // blank-complete character is exactly the case this issue exists for.
      semanticReviewed: false,
    };
  });
  return {
    findings,
    coverage,
    reviewedCount: coverage.filter((c) => c.status !== 'not-reviewed').length,
    castCount: cast.length,
    semanticReviewedCount: 0,
  };
}

/**
 * Every field path a finding may legally name. A model-authored finding
 * pointing anywhere else is dropped rather than rendered — the report must not
 * be able to invent a field the editor has no input for.
 */
export const INTEGRITY_FIELD_PATHS = Object.freeze([
  ...INTEGRITY_FIELDS,
  'relationshipLinks',
  'psychology.theoryOfControl',
  'psychology.strategy',
  'psychology.protectiveBenefit',
  'psychology.presentCost',
  'psychology.testingPressure',
  'psychology.candidateChange',
  ...PSYCHOLOGY_DRIVE_AXES.flatMap((axis) => [
    `psychology.drives.${axis}.desire`,
    `psychology.drives.${axis}.fear`,
  ]),
]);
const FIELD_PATH_SET = new Set(INTEGRITY_FIELD_PATHS);

/**
 * Fold a model's semantic findings into a deterministic report.
 *
 * Everything here is validation, because the input is an LLM payload: a finding
 * naming a character outside the cast, an unknown field path, an unknown kind
 * or an unknown dimension is DROPPED rather than shown — a review that invents
 * a field is worse than a review that reports less.
 *
 * `reviewedIds` is what the caller actually managed to review; ids in scope but
 * absent from it become `truncated`, so a budget-capped batch cannot read as a
 * clean pass over the whole cast.
 */
export function mergeSemanticFindings(report, {
  characters, findings = [], reviewedIds = [], truncated = false,
} = {}) {
  const cast = Array.isArray(characters) ? characters.filter((c) => c?.id) : [];
  const byId = new Map(cast.map((c) => [c.id, c]));
  const reviewed = new Set(reviewedIds.filter((id) => byId.has(id)));
  const seen = new Set();
  const accepted = [];
  for (const raw of Array.isArray(findings) ? findings : []) {
    const entry = byId.get(raw?.characterId);
    if (!entry || !reviewed.has(raw.characterId)) continue;
    const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
    if (!FINDING_KIND_SET.has(kind)) continue;
    const field = typeof raw.field === 'string' ? raw.field.trim() : '';
    if (!FIELD_PATH_SET.has(field)) continue;
    const dimension = typeof raw.dimension === 'string' ? raw.dimension.trim() : '';
    if (dimension && !DIMENSION_ID_SET.has(dimension)) continue;
    // A dimension the character's depth excuses must not produce a finding —
    // that is how "lighter requirements" stays a real guarantee rather than a
    // prompt suggestion the model can talk itself out of.
    const allowedDims = characterIntegrityDimensions(entry);
    if (dimension && !allowedDims.includes(dimension)) continue;
    const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
    // Evidence is the whole product. A finding that only asserts a problem is
    // not reviewable by the author, so it is not worth showing.
    if (!evidence) continue;
    const finding = makeFinding({
      characterId: raw.characterId,
      characterName: entry.name,
      kind,
      field,
      dimension: dimension || null,
      evidence,
      suggestion: typeof raw.suggestion === 'string' ? raw.suggestion.trim() : '',
    });
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    accepted.push(finding);
  }

  // Deterministic findings win a collision: they state a fact (the field is
  // empty) where the model states a judgement about the same field.
  const deterministic = Array.isArray(report?.findings) ? report.findings : [];
  const deterministicIds = new Set(deterministic.map((f) => f.id));
  const merged = [...deterministic, ...accepted.filter((f) => !deterministicIds.has(f.id))];
  const countsById = merged.reduce((acc, f) => {
    acc[f.characterId] = (acc[f.characterId] || 0) + 1;
    return acc;
  }, {});

  const coverage = (report?.coverage || []).map((row) => {
    if (row.status === 'not-reviewed') return row;
    const semanticReviewed = reviewed.has(row.characterId);
    const findingCount = countsById[row.characterId] || 0;
    // In deterministic scope but the semantic pass never reached it.
    if (!semanticReviewed) {
      return {
        ...row,
        status: truncated ? 'truncated' : row.status,
        findingCount,
        semanticReviewed: false,
      };
    }
    return {
      ...row,
      status: findingCount ? 'findings' : 'passed',
      findingCount,
      semanticReviewed: true,
    };
  });

  return {
    ...report,
    findings: merged,
    coverage,
    semanticReviewedCount: coverage.filter((c) => c.semanticReviewed).length,
  };
}

/**
 * The field paths the augment flow may propose a value for: every integrity
 * path that holds a plain STRING.
 *
 * `psychology` (the container) and `relationshipLinks` are excluded because
 * they are not prose — a "before / after" preview of a structured object is not
 * something an author can review field-by-field, and a link row points at a
 * sibling id no model can mint. Both can still be REPORTED on; they just can't
 * be machine-repaired.
 */
export const AUGMENTABLE_FIELD_PATHS = Object.freeze(
  INTEGRITY_FIELD_PATHS.filter((p) => p !== 'psychology' && p !== 'relationshipLinks'),
);
const AUGMENTABLE_PATH_SET = new Set(AUGMENTABLE_FIELD_PATHS);

/** Whether a dotted path names a string-valued integrity field. */
export const isAugmentableFieldPath = (path) => AUGMENTABLE_PATH_SET.has(path);

/** Current value at a dotted integrity path — `''` when unset at any level. */
export function readIntegrityField(entry, path) {
  if (!entry || typeof entry !== 'object' || !AUGMENTABLE_PATH_SET.has(path)) return '';
  const value = path.split('.').reduce((node, key) => (
    node && typeof node === 'object' ? node[key] : undefined
  ), entry);
  return typeof value === 'string' ? value : '';
}

/**
 * A copy of `entry` with `path` set to `value`, materializing the psychology
 * container and drive rows as needed. Pure — the caller still runs the result
 * through the bible sanitizer before persisting.
 */
export function withIntegrityField(entry, path, value) {
  if (!entry || typeof entry !== 'object' || !AUGMENTABLE_PATH_SET.has(path)) return entry;
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { ...entry, [head]: value };
  const psychology = (entry.psychology && typeof entry.psychology === 'object' && !Array.isArray(entry.psychology))
    ? entry.psychology
    : {};
  if (rest.length === 1) return { ...entry, psychology: { ...psychology, [rest[0]]: value } };
  // psychology.drives.<axis>.<leaf>
  const [, axis, leaf] = rest;
  const drives = (psychology.drives && typeof psychology.drives === 'object') ? psychology.drives : {};
  const row = (drives[axis] && typeof drives[axis] === 'object') ? drives[axis] : {};
  return {
    ...entry,
    psychology: { ...psychology, drives: { ...drives, [axis]: { ...row, [leaf]: value } } },
  };
}
