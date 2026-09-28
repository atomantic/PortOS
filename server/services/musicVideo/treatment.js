/**
 * Music Video — pre-production treatment record transforms (#8980).
 *
 * A project may carry an optional, editable `treatment` between the director's
 * concept/visual spec and the deterministic timed-shot planner:
 *
 *   - `brief`: audience, destination/aspect ratio, emotion, premise, opening
 *     hook objective, must-have/avoid aesthetics and manually supplied
 *     reference notes/URLs (provenance only — never fetched, never obeyed);
 *   - `arc`: the compiled whole-song treatment — one beat per analyzed section
 *     (opening / build / contrast / payoff / release), recurring motifs and how
 *     they change, the performance/cutaway/graphic balance, each with a short
 *     rationale;
 *   - `shotDirections`: per-shot direction keyed to the board's REAL scene ids
 *     (focal subject, framing, reserved negative space, typography role,
 *     emphasis, entry/exit transition, route). Timing stays authoritative on
 *     the scenes the planner produced — a direction never moves a cut;
 *   - `proofs`: a bounded proof checklist (the highest-risk shot and one short
 *     transition/text sequence) whose entries stay `proposed` until a review
 *     names a real artifact of this project;
 *   - `capabilityGaps`: what the treatment asks for that this install cannot
 *     do yet (source-audio lip-sync, footage-to-vector rotoscoping, …), stated
 *     instead of promised.
 *
 * Versioning. Every write bumps `revision`, and every write names the revision
 * it was based on — a stale tab, or a compile whose LLM call raced an edit,
 * gets a 409 instead of overwriting newer work. `basis` fingerprints the
 * inputs a compile read (audio source, analysis, visual spec, lyrics, scene
 * set); a changed input makes the treatment stale, and Apply refuses a stale
 * treatment rather than writing old direction over newer edits.
 *
 * Apply is explicit and non-destructive: it writes each scene's `direction`
 * (with the composed frame/motion prompt clauses), fills empty prompts or ones
 * the treatment itself wrote last time, and keeps any prompt the director
 * edited by hand unless they explicitly list that scene with the fingerprint
 * of the prompts they reviewed. Takes and slot selections are never touched.
 *
 * Peer sync: the treatment and `scene.direction` are additive fields on the
 * whole-record LWW project body. An older peer stores them verbatim, carries
 * them through its own edits (every mutator spreads the record), and never
 * executes them, so no `musicVideoProjects` schema bump is needed.
 */

import { createHash, randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { trimTo, isNonBlankStr } from '../../lib/textUtils.js';
import {
  MUSIC_VIDEO_ASPECT_RATIOS as ASPECT_RATIOS,
  MUSIC_VIDEO_BEAT_ROLES as BEAT_ROLES,
  MUSIC_VIDEO_SHOT_MODES as SHOT_MODES,
  MUSIC_VIDEO_SHOT_ROUTES as SHOT_ROUTES,
  MUSIC_VIDEO_NEGATIVE_SPACE as NEGATIVE_SPACE,
  MUSIC_VIDEO_TYPOGRAPHY_ROLES as TYPOGRAPHY_ROLES,
  MUSIC_VIDEO_PROOF_CHECKS as PROOF_CHECKS,
  MUSIC_VIDEO_PROOF_STATUSES as PROOF_STATUSES,
} from '../../lib/musicVideoValidation.js';
import { normalizeComposition } from './composition.js';

const TREATMENT_VERSION = 1;

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const text = (value, max) => trimTo(value, max);
const round3 = (n) => Math.round(n * 1000) / 1000;
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Short, stable content fingerprint (not a security boundary — change detection only). */
function fingerprint(value) {
  return createHash('sha1').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12);
}

/** The fingerprint of a scene's two prompts — what Apply's overwrite list is checked against. */
function scenePromptFingerprint(scene) {
  return fingerprint([scene?.framePrompt || '', scene?.prompt || '']);
}

function treatmentError(status, code, message, context) {
  return new ServerError(message, { status, code, ...(context ? { context } : {}) });
}

// ---- normalization ----------------------------------------------------------

function normalizeReferenceNotes(list, previous = [], now) {
  const prior = new Map((Array.isArray(previous) ? previous : []).map((n) => [n.id, n]));
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    const note = text(entry.note, 1000);
    const url = typeof entry.url === 'string' && /^https?:\/\/\S+$/i.test(entry.url.trim()) ? entry.url.trim().slice(0, 2000) : null;
    if (!note && !url) continue;
    const id = typeof entry.id === 'string' && entry.id && !seen.has(entry.id) ? entry.id : `mvn-${randomUUID()}`;
    seen.add(id);
    // Provenance: every note is the director's own input, stamped when first added.
    out.push({ id, note, url, source: 'user', addedAt: prior.get(id)?.addedAt || entry.addedAt || now });
  }
  return out.slice(0, 20);
}

/** Merge a brief patch onto the stored brief; absent fields keep their value. */
export function normalizeBrief(patch, base = null, now = new Date().toISOString()) {
  const merged = { ...(base || {}), ...(patch || {}) };
  return {
    audience: text(merged.audience, 500),
    destination: text(merged.destination, 200),
    aspectRatio: pick(merged.aspectRatio, ASPECT_RATIOS, null),
    emotion: text(merged.emotion, 500),
    premise: text(merged.premise, 2000),
    hookObjective: text(merged.hookObjective, 1000),
    mustHave: text(merged.mustHave, 2000),
    avoid: text(merged.avoid, 2000),
    referenceNotes: normalizeReferenceNotes(merged.referenceNotes, base?.referenceNotes, now),
  };
}

function normalizeMotifs(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((m) => {
    if (!m || typeof m !== 'object') return null;
    const name = text(m.name, 120);
    if (!name) return null;
    const id = typeof m.id === 'string' && m.id && !seen.has(m.id) ? m.id : `mvm-${randomUUID()}`;
    seen.add(id);
    return {
      id,
      name,
      description: text(m.description, 1000),
      evolution: text(m.evolution, 1000),
      rationale: text(m.rationale, 1000),
    };
  }).filter(Boolean).slice(0, 12);
}

function normalizeBalance(balance) {
  const raw = SHOT_MODES.map((mode) => {
    const v = Number(balance?.[mode]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  // Percentages that always sum to 100 (largest remainder), or an even split.
  const shares = total > 0 ? raw.map((v) => (v / total) * 100) : SHOT_MODES.map(() => 100 / SHOT_MODES.length);
  const floors = shares.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  shares.map((s, i) => [s - floors[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (left > 0) { floors[i] += 1; left -= 1; }
  });
  return {
    ...Object.fromEntries(SHOT_MODES.map((mode, i) => [mode, floors[i]])),
    rationale: text(balance?.rationale, 1000),
  };
}

function normalizeBeat(beat) {
  return {
    id: typeof beat.id === 'string' && beat.id ? beat.id : `mvb-${randomUUID()}`,
    role: pick(beat.role, BEAT_ROLES, 'build'),
    sectionIndexes: (Array.isArray(beat.sectionIndexes) ? beat.sectionIndexes : [])
      .filter((i) => Number.isInteger(i) && i >= 0).slice(0, 50),
    label: text(beat.label, 120),
    startSec: isTime(beat.startSec) ? round3(beat.startSec) : null,
    endSec: isTime(beat.endSec) ? round3(beat.endSec) : null,
    energy: typeof beat.energy === 'number' && Number.isFinite(beat.energy) ? round3(beat.energy) : null,
    objective: text(beat.objective, 1000),
    rationale: text(beat.rationale, 1000),
  };
}

function normalizeArc(arc) {
  if (!arc || typeof arc !== 'object' || Array.isArray(arc)) return null;
  return {
    rationale: text(arc.rationale, 2000),
    // null (not '') for an instrumental song: nothing to interpret.
    lyricInterpretation: typeof arc.lyricInterpretation === 'string' ? text(arc.lyricInterpretation, 2000) : null,
    beats: (Array.isArray(arc.beats) ? arc.beats : []).filter((b) => b && typeof b === 'object').map(normalizeBeat).slice(0, 200),
    motifs: normalizeMotifs(arc.motifs),
    balance: normalizeBalance(arc.balance),
  };
}

function normalizeShotDirection(d) {
  return {
    sceneId: String(d.sceneId),
    beatId: typeof d.beatId === 'string' && d.beatId ? d.beatId : null,
    mode: pick(d.mode, SHOT_MODES, 'cutaway'),
    route: pick(d.route, SHOT_ROUTES, 'generated'),
    focalSubject: text(d.focalSubject, 500),
    framing: text(d.framing, 500),
    negativeSpace: pick(d.negativeSpace, NEGATIVE_SPACE, 'none'),
    typographyRole: pick(d.typographyRole, TYPOGRAPHY_ROLES, 'none'),
    emphasis: text(d.emphasis, 500),
    transitionIn: text(d.transitionIn, 300),
    transitionOut: text(d.transitionOut, 300),
    rationale: text(d.rationale, 1000),
    suggestedFramePrompt: text(d.suggestedFramePrompt, 2000),
    suggestedPrompt: text(d.suggestedPrompt, 2000),
  };
}

function normalizeShotDirections(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && typeof d === 'object' && isNonBlankStr(d.sceneId) && !seen.has(d.sceneId) && seen.add(d.sceneId))
    .map(normalizeShotDirection)
    .slice(0, 500);
}

function normalizeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    videoHistoryId: isNonBlankStr(evidence.videoHistoryId) ? evidence.videoHistoryId.slice(0, 64) : null,
    imageId: isNonBlankStr(evidence.imageId) ? evidence.imageId.slice(0, 256) : null,
    note: text(evidence.note, 2000),
    reviewedAt: typeof evidence.reviewedAt === 'string' ? evidence.reviewedAt : null,
  };
}

function normalizeProofs(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && typeof p === 'object').map((p) => {
    const status = pick(p.status, PROOF_STATUSES, 'proposed');
    const evidence = normalizeEvidence(p.evidence);
    return {
      id: typeof p.id === 'string' && p.id ? p.id : `mvp-${randomUUID()}`,
      kind: p.kind === 'transition-text' ? 'transition-text' : 'risk-shot',
      sceneIds: (Array.isArray(p.sceneIds) ? p.sceneIds : []).filter(isNonBlankStr).slice(0, 4),
      artifact: text(p.artifact, 500),
      risk: text(p.risk, 1000),
      route: text(p.route, 500),
      checks: (Array.isArray(p.checks) ? p.checks : []).filter((c) => PROOF_CHECKS.includes(c)),
      passCriteria: (Array.isArray(p.passCriteria) ? p.passCriteria : []).map((c) => text(c, 500)).filter(Boolean).slice(0, 8),
      // A passed/failed verdict without its evidence record is not a verdict.
      status: status !== 'proposed' && !evidence ? 'proposed' : status,
      evidence: status === 'proposed' ? null : evidence,
    };
  }).slice(0, 4);
}

function normalizeGaps(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((g) => g && isNonBlankStr(g.id) && !seen.has(g.id) && seen.add(g.id))
    .map((g) => ({ id: g.id.slice(0, 40), detail: text(g.detail, 1000) }))
    .slice(0, 10);
}

function normalizeBasis(basis) {
  if (!basis || typeof basis !== 'object') return null;
  const out = {};
  for (const key of BASIS_KEYS) out[key] = typeof basis[key] === 'string' ? basis[key] : null;
  return out;
}

/**
 * Normalize a stored (or legacy / peer-supplied) treatment to its full shape.
 * Returns null for a non-object so a project without a treatment stays null.
 */
function normalizeTreatment(input, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return {
    version: TREATMENT_VERSION,
    revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    brief: normalizeBrief(input.brief, null, now),
    arc: normalizeArc(input.arc),
    shotDirections: normalizeShotDirections(input.shotDirections),
    proofs: normalizeProofs(input.proofs),
    capabilityGaps: normalizeGaps(input.capabilityGaps),
    basis: normalizeBasis(input.basis),
    compiledAt: typeof input.compiledAt === 'string' ? input.compiledAt : null,
    compiledWith: input.compiledWith && typeof input.compiledWith === 'object' ? {
      source: input.compiledWith.source === 'ai' ? 'ai' : 'deterministic',
      providerId: isNonBlankStr(input.compiledWith.providerId) ? input.compiledWith.providerId.slice(0, 64) : null,
      model: isNonBlankStr(input.compiledWith.model) ? input.compiledWith.model.slice(0, 200) : null,
    } : null,
    appliedRevision: Number.isInteger(input.appliedRevision) ? input.appliedRevision : null,
    appliedAt: typeof input.appliedAt === 'string' ? input.appliedAt : null,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
  };
}

// A brand-new treatment starts at revision 0 so its first write stamps it 1.
const blankTreatment = (now) => ({ ...normalizeTreatment({}, now), revision: 0 });

/** The currently stored revision (0 when the project has no treatment yet). */
function treatmentRevision(project) {
  return normalizeTreatment(project?.treatment)?.revision ?? 0;
}

function assertRevision(project, baseRevision) {
  const current = treatmentRevision(project);
  if (baseRevision !== current) {
    throw treatmentError(409, 'TREATMENT_REVISION_CONFLICT',
      `The treatment changed since this edit was made (revision ${current}, edit based on ${baseRevision}) — reload and try again`,
      { currentRevision: current });
  }
}

// ---- basis / staleness ------------------------------------------------------

const BASIS_KEYS = ['audio', 'analysis', 'visualSpec', 'lyrics', 'scenes'];
const STALE_MESSAGES = {
  audio: 'The song changed since this treatment was compiled — recompile it.',
  analysis: 'The song was re-analyzed since this treatment was compiled.',
  visualSpec: 'The visual spec changed since this treatment was compiled.',
  lyrics: 'The lyric cues changed since this treatment was compiled.',
  scenes: 'Scenes were added, removed or retimed since this treatment was compiled.',
};
// A stale basis on these inputs blocks Apply (old direction must not overwrite
// newer edits); scene-set changes only leave some scenes unmapped.
const BLOCKING_STALE = new Set(['audio', 'analysis', 'visualSpec', 'lyrics']);

/** Fingerprints of every input a compile reads. */
export function treatmentBasis(project) {
  const analysis = project?.audioAnalysis;
  const spec = project?.visualSpec;
  return {
    audio: fingerprint([project?.trackId ?? null, project?.uploadedAudioFilename ?? null]),
    analysis: fingerprint(analysis
      ? [analysis.durationSec ?? null, (analysis.sections || []).map((s) => [s?.startSec ?? null, s?.endSec ?? null, s?.energy ?? null])]
      : null),
    visualSpec: fingerprint(spec ? [
      (spec.references || []).map((r) => [r.imageId, r.role || 'mood', r.use || 'reference', r.label || '', r.note || '']),
      spec.palette || [], spec.typography || '', spec.cameraRules || '',
    ] : null),
    lyrics: fingerprint((project?.lyricCues || []).map((c) => [c.text, c.startSec ?? null, c.endSec ?? null])),
    scenes: fingerprint((project?.scenes || []).map((s) => [s.sceneId, s.startSec ?? null, s.endSec ?? null])),
  };
}

/** Inputs that changed since the treatment was compiled: `[{ input, blocking, message }]`. */
function treatmentStaleness(project, treatment = normalizeTreatment(project?.treatment)) {
  if (!treatment?.basis) return [];
  const current = treatmentBasis(project);
  return BASIS_KEYS
    .filter((key) => treatment.basis[key] !== current[key])
    .map((key) => ({ input: key, blocking: BLOCKING_STALE.has(key), message: STALE_MESSAGES[key] }));
}

function stamp(project, treatment, now) {
  return { ...project, treatment: { ...treatment, revision: treatment.revision + 1, updatedAt: now }, updatedAt: now };
}

// ---- edits ------------------------------------------------------------------

/**
 * Apply a director's edit (brief, beat objectives, motifs, shot directions, or
 * a rebase onto the current inputs). Creates the treatment on first edit.
 */
export function applyTreatmentPatch(project, patch, now = new Date().toISOString()) {
  assertRevision(project, patch.baseRevision);
  const existing = normalizeTreatment(project.treatment, now);
  const next = existing || blankTreatment(now);
  if (patch.brief) next.brief = normalizeBrief(patch.brief, next.brief, now);

  const needsArc = patch.beats || patch.motifs;
  if (needsArc && !next.arc) {
    throw treatmentError(409, 'TREATMENT_NOT_COMPILED', 'Compile the treatment before editing its arc');
  }
  if (patch.beats) {
    const byId = new Map(next.arc.beats.map((b) => [b.id, b]));
    for (const edit of patch.beats) {
      const beat = byId.get(edit.id);
      if (!beat) throw treatmentError(404, 'NOT_FOUND', `Unknown treatment beat ${edit.id}`);
      if (edit.objective !== undefined) beat.objective = text(edit.objective, 1000);
      if (edit.rationale !== undefined) beat.rationale = text(edit.rationale, 1000);
    }
  }
  if (patch.motifs) next.arc = { ...next.arc, motifs: normalizeMotifs(patch.motifs) };
  if (patch.shotDirections) {
    const byScene = new Map(next.shotDirections.map((d, i) => [d.sceneId, i]));
    for (const edit of patch.shotDirections) {
      const idx = byScene.get(edit.sceneId);
      if (idx === undefined) throw treatmentError(404, 'NOT_FOUND', `The treatment has no direction for scene ${edit.sceneId}`);
      next.shotDirections[idx] = normalizeShotDirection({ ...next.shotDirections[idx], ...edit });
    }
  }
  if (patch.rebase && next.basis) {
    const stale = treatmentStaleness(project, next);
    if (stale.some((s) => s.input === 'audio')) {
      throw treatmentError(409, 'TREATMENT_AUDIO_CHANGED', STALE_MESSAGES.audio);
    }
    next.basis = treatmentBasis(project);
  }
  return stamp(project, next, now);
}

/**
 * Persist a compiled draft. Refused when the treatment was edited, or any of
 * its inputs changed, while the (possibly slow) compile was running — the
 * compile read the older state and must not overwrite the newer one.
 */
export function writeCompiledTreatment(project, { baseRevision, draft, basis, compiledWith, now = new Date().toISOString() }) {
  assertRevision(project, baseRevision);
  const current = treatmentBasis(project);
  const changed = BASIS_KEYS.filter((key) => current[key] !== basis[key]);
  if (changed.length > 0) {
    throw treatmentError(409, 'TREATMENT_INPUTS_CHANGED',
      `The project changed while the treatment was compiling (${changed.join(', ')}) — compile again`,
      { changed });
  }
  const existing = normalizeTreatment(project.treatment, now);
  const next = {
    ...(existing || blankTreatment(now)),
    arc: normalizeArc(draft.arc),
    shotDirections: normalizeShotDirections(draft.shotDirections),
    // A new compile proposes a fresh checklist: earlier verdicts reviewed
    // different shots/direction.
    proofs: normalizeProofs(draft.proofs),
    capabilityGaps: normalizeGaps(draft.capabilityGaps),
    basis,
    compiledAt: now,
    compiledWith,
  };
  return stamp(project, next, now);
}

// ---- proofs -----------------------------------------------------------------

// Which evidence each check can accept. A still frame or a contact sheet never
// proves motion; audio alignment and lip-sync can only be judged in the final
// render, the one artifact that carries the song; composited text only exists
// in the final render too.
const RENDER_ONLY_CHECKS = new Set(['audio-alignment', 'lip-sync', 'readable-text']);
const MOTION_CHECKS = new Set(['continuous-motion', 'cut-continuity']);

function proofArtifacts(project, proof) {
  const scenes = (project.scenes || []).filter((s) => proof.sceneIds.includes(s.sceneId));
  const clips = new Set();
  const frames = new Set();
  for (const scene of scenes) {
    if (isNonBlankStr(scene.videoHistoryId)) clips.add(scene.videoHistoryId);
    if (isNonBlankStr(scene.referenceImageId)) frames.add(scene.referenceImageId);
    for (const take of Array.isArray(scene.takes) ? scene.takes : []) {
      if (take?.kind === 'video') clips.add(take.assetId);
      if (take?.kind === 'image') frames.add(take.assetId);
    }
  }
  return { clips, frames, render: isNonBlankStr(project.renderHistoryId) ? project.renderHistoryId : null };
}

/**
 * Record a proof review. `passed` must cite a real artifact of this project
 * that can actually show every check: the final render for audio alignment,
 * lip-sync and composited text; a clip (or the render) for motion and cut
 * continuity; any frame or clip for identity. Lip-sync cannot pass while the
 * treatment records that this install has no lip-sync capability.
 */
export function reviewTreatmentProof(project, proofId, { baseRevision, status, evidence }, now = new Date().toISOString()) {
  assertRevision(project, baseRevision);
  const treatment = normalizeTreatment(project.treatment, now);
  const idx = treatment.proofs.findIndex((p) => p.id === proofId);
  if (idx < 0) throw treatmentError(404, 'NOT_FOUND', 'Proof checklist entry not found');
  const proof = treatment.proofs[idx];
  let recorded = null;
  if (status !== 'proposed') {
    recorded = normalizeEvidence({ ...(evidence || {}), reviewedAt: now });
    if (status === 'passed') {
      if (!recorded.note) throw treatmentError(422, 'PROOF_EVIDENCE_REQUIRED', 'Describe what you reviewed before marking a proof passed');
      const { clips, frames, render } = proofArtifacts(project, proof);
      const isRender = !!recorded.videoHistoryId && recorded.videoHistoryId === render;
      const isClip = !!recorded.videoHistoryId && (clips.has(recorded.videoHistoryId) || isRender);
      const isFrame = !!recorded.imageId && frames.has(recorded.imageId);
      if (recorded.videoHistoryId && !isClip) {
        throw treatmentError(422, 'PROOF_EVIDENCE_NOT_FOUND', 'That video is not a clip of this proof\'s scenes or the project\'s final render');
      }
      if (recorded.imageId && !isFrame) {
        throw treatmentError(422, 'PROOF_EVIDENCE_NOT_FOUND', 'That image is not a frame of this proof\'s scenes');
      }
      if (proof.checks.includes('lip-sync') && treatment.capabilityGaps.some((g) => g.id === 'lip-sync')) {
        throw treatmentError(422, 'PROOF_CAPABILITY_MISSING', 'This install has no source-audio lip-sync, so a lip-sync check cannot pass');
      }
      const needsRender = proof.checks.filter((c) => RENDER_ONLY_CHECKS.has(c));
      if (needsRender.length > 0 && !isRender) {
        throw treatmentError(422, 'PROOF_EVIDENCE_INSUFFICIENT', `${needsRender.join(', ')} can only be judged in the final render with the song — cite the project's render`);
      }
      const needsMotion = proof.checks.filter((c) => MOTION_CHECKS.has(c));
      if (needsMotion.length > 0 && !isClip) {
        throw treatmentError(422, 'PROOF_EVIDENCE_INSUFFICIENT', `${needsMotion.join(', ')} needs a played clip or render — a still frame or contact sheet cannot prove motion`);
      }
      if (!isClip && !isFrame) {
        throw treatmentError(422, 'PROOF_EVIDENCE_REQUIRED', 'Cite the frame, clip or render you reviewed');
      }
    }
  }
  treatment.proofs[idx] = { ...proof, status, evidence: recorded };
  return stamp(project, treatment, now);
}

// ---- apply ------------------------------------------------------------------

const REGION_PHRASE = { upper: 'upper third', center: 'center', lower: 'lower third' };

/**
 * The composition constraints a direction adds to a scene's frame (image) and
 * motion (video) prompts. Text is never requested from the image/video model:
 * the reserved region stays clean for the independently rendered typography
 * layer, and every clause asks for no lettering in the picture.
 */
function composeDirectionClauses(direction, { aspectRatio = null, lipSyncUnavailable = false } = {}) {
  const region = REGION_PHRASE[direction.negativeSpace] || null;
  const frame = [
    aspectRatio ? `composed for a ${aspectRatio} frame` : '',
    direction.focalSubject ? `focal subject: ${direction.focalSubject}` : '',
    direction.framing ? `framing: ${direction.framing}` : '',
    direction.emphasis ? `visual emphasis: ${direction.emphasis}` : '',
    region ? `keep the ${region} of the frame clean, low-detail negative space for a separately composited title` : '',
    'no text, letters, captions, logos or signage in the image',
  ];
  const motion = [
    direction.transitionIn ? `entry: ${direction.transitionIn}` : '',
    direction.transitionOut ? `exit: ${direction.transitionOut}` : '',
    region ? `keep the ${region} of the frame clear throughout the move` : '',
    direction.mode === 'performance' && lipSyncUnavailable ? 'the performer does not sing or mouth words to camera' : '',
    'no on-screen text',
  ];
  return {
    frameClause: frame.filter(Boolean).join('; '),
    motionClause: motion.filter(Boolean).join('; '),
  };
}

const DIRECTION_FIELDS = ['beatId', 'mode', 'route', 'focalSubject', 'framing', 'negativeSpace', 'typographyRole', 'emphasis', 'transitionIn', 'transitionOut'];
const directionKey = (d) => fingerprint(DIRECTION_FIELDS.map((f) => d?.[f] ?? null));

function sceneDirection(treatment, direction) {
  const clauses = composeDirectionClauses(direction, {
    aspectRatio: treatment.brief.aspectRatio,
    lipSyncUnavailable: treatment.capabilityGaps.some((g) => g.id === 'lip-sync'),
  });
  return {
    ...Object.fromEntries(DIRECTION_FIELDS.map((f) => [f, direction[f]])),
    ...clauses,
  };
}

// How Apply treats a scene's prompts: `fill` (empty), `replace` (still exactly
// what the treatment wrote last time), `unchanged` (already the suggestion),
// `manual` (edited by hand — kept unless explicitly overwritten), `none` (the
// direction carries no suggested prompts).
function promptPlan(scene, direction) {
  const suggestion = { framePrompt: direction.suggestedFramePrompt, prompt: direction.suggestedPrompt };
  if (!suggestion.framePrompt && !suggestion.prompt) return 'none';
  const next = {
    framePrompt: suggestion.framePrompt || scene.framePrompt || '',
    prompt: suggestion.prompt || scene.prompt || '',
  };
  if (scenePromptFingerprint(next) === scenePromptFingerprint(scene)) return 'unchanged';
  if (!isNonBlankStr(scene.framePrompt) && !isNonBlankStr(scene.prompt)) return 'fill';
  if (scene.direction?.appliedPromptFingerprint === scenePromptFingerprint(scene)) return 'replace';
  return 'manual';
}

function textCueCandidates(project, treatment) {
  const scenes = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const cues = (project.lyricCues || []).filter((c) => isNonBlankStr(c?.text) && isTime(c.startSec));
  const existing = new Set((project.composition?.textCues || []).map((c) => `${c.text}@${c.startSec}`));
  const out = [];
  for (const direction of treatment.shotDirections) {
    if (direction.typographyRole === 'none') continue;
    const scene = scenes.get(direction.sceneId);
    if (!scene || !isTime(scene.startSec) || !isTime(scene.endSec)) continue;
    for (const cue of cues) {
      if (cue.startSec < scene.startSec || cue.startSec >= scene.endSec) continue;
      const cueText = cue.text.trim().slice(0, 500);
      if (existing.has(`${cueText}@${cue.startSec}`)) continue;
      existing.add(`${cueText}@${cue.startSec}`);
      const endSec = isTime(cue.endSec) && cue.endSec > cue.startSec ? cue.endSec : scene.endSec;
      out.push({
        text: cueText,
        startSec: cue.startSec,
        endSec,
        placement: direction.negativeSpace === 'none' ? 'lower' : direction.negativeSpace,
        emphasis: direction.typographyRole,
        template: direction.typographyRole === 'hero' ? 'rise' : 'fade',
      });
    }
  }
  return out;
}

/**
 * What Apply would do right now: which scenes' direction changes, which
 * prompts it fills/replaces, which hand-edited prompts it keeps, and whether a
 * stale input blocks it. The same function drives Apply itself, so the preview
 * the director reviewed and the write can't disagree about a scene.
 */
export function buildApplyPreview(project) {
  const treatment = normalizeTreatment(project.treatment);
  if (!treatment?.arc) {
    throw treatmentError(409, 'TREATMENT_NOT_COMPILED', 'Compile the treatment before applying it');
  }
  const stale = treatmentStaleness(project, treatment);
  const scenesById = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const directed = new Set();
  const scenes = [];
  const missingSceneIds = [];
  for (const direction of treatment.shotDirections) {
    const scene = scenesById.get(direction.sceneId);
    if (!scene) { missingSceneIds.push(direction.sceneId); continue; }
    directed.add(scene.sceneId);
    const next = sceneDirection(treatment, direction);
    scenes.push({
      sceneId: scene.sceneId,
      label: scene.label || scene.sectionLabel || '',
      directionChanged: directionKey(scene.direction) !== directionKey(next)
        || scene.direction?.frameClause !== next.frameClause || scene.direction?.motionClause !== next.motionClause,
      prompt: promptPlan(scene, direction),
      promptFingerprint: scenePromptFingerprint(scene),
      current: { framePrompt: scene.framePrompt || '', prompt: scene.prompt || '' },
      suggested: { framePrompt: direction.suggestedFramePrompt, prompt: direction.suggestedPrompt },
      keepsSelection: isNonBlankStr(scene.referenceImageId) || isNonBlankStr(scene.videoHistoryId),
    });
  }
  return {
    revision: treatment.revision,
    stale,
    blocked: stale.some((s) => s.blocking),
    scenes,
    missingSceneIds,
    unmappedSceneIds: (project.scenes || []).map((s) => s.sceneId).filter((id) => !directed.has(id)),
    textCueCandidates: textCueCandidates(project, treatment).length,
  };
}

/**
 * Apply the treatment's direction to the board. Refused when the revision the
 * director reviewed is not the current one, or when a blocking input is stale.
 * Returns `{ project, result }`.
 */
export function applyTreatmentToProject(project, { revision, overwrite = [], addTextCues = false }, now = new Date().toISOString()) {
  const treatment = normalizeTreatment(project.treatment, now);
  if (!treatment?.arc) throw treatmentError(409, 'TREATMENT_NOT_COMPILED', 'Compile the treatment before applying it');
  if (treatment.revision !== revision) {
    throw treatmentError(409, 'TREATMENT_REVISION_CONFLICT',
      `The treatment changed since it was reviewed (revision ${treatment.revision}) — review it again`,
      { currentRevision: treatment.revision });
  }
  const preview = buildApplyPreview(project);
  if (preview.blocked) {
    throw treatmentError(409, 'TREATMENT_STALE',
      `${preview.stale.filter((s) => s.blocking).map((s) => s.message).join(' ')} Recompile, or keep it for the current inputs, before applying.`,
      { stale: preview.stale.map((s) => s.input) });
  }
  const approved = new Map(overwrite.map((o) => [o.sceneId, o.promptFingerprint]));
  const plans = new Map(preview.scenes.map((p) => [p.sceneId, p]));
  const directions = new Map(treatment.shotDirections.map((d) => [d.sceneId, d]));
  const result = { directed: 0, promptsWritten: [], promptsKept: [], conflicted: [], textCuesAdded: 0 };

  const scenes = (project.scenes || []).map((scene) => {
    const plan = plans.get(scene.sceneId);
    if (!plan) return scene;
    const direction = directions.get(scene.sceneId);
    const next = { ...scene };
    let write = plan.prompt === 'fill' || plan.prompt === 'replace';
    if (plan.prompt === 'manual' && approved.has(scene.sceneId)) {
      // The fingerprint pins the exact prompts the director reviewed: an edit
      // made after that review is newer work and is kept.
      if (approved.get(scene.sceneId) === plan.promptFingerprint) write = true;
      else result.conflicted.push(scene.sceneId);
    } else if (plan.prompt === 'manual') {
      result.promptsKept.push(scene.sceneId);
    }
    if (write) {
      if (direction.suggestedFramePrompt) next.framePrompt = direction.suggestedFramePrompt;
      if (direction.suggestedPrompt) next.prompt = direction.suggestedPrompt;
      result.promptsWritten.push(scene.sceneId);
    }
    const owned = write || plan.prompt === 'unchanged';
    next.direction = {
      ...sceneDirection(treatment, direction),
      treatmentRevision: treatment.revision,
      // Only prompts the treatment wrote (or that already match it) are
      // treatment-owned; a kept hand edit keeps its previous ownership marker so
      // it still reads as manual next time.
      appliedPromptFingerprint: owned ? scenePromptFingerprint(next) : (scene.direction?.appliedPromptFingerprint ?? null),
    };
    result.directed += 1;
    return next;
  });

  let composition = project.composition ?? null;
  if (addTextCues) {
    const added = textCueCandidates(project, treatment);
    if (added.length > 0) {
      const base = normalizeComposition(composition || {});
      composition = normalizeComposition({ ...base, textCues: [...base.textCues, ...added].sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0)) });
      result.textCuesAdded = added.length;
    }
  }

  return {
    project: {
      ...project,
      scenes,
      composition,
      treatment: { ...treatment, appliedRevision: treatment.revision, appliedAt: now },
      updatedAt: now,
    },
    result,
  };
}

// ---- clone ------------------------------------------------------------------

/**
 * Carry a treatment into a cloned project whose scenes got new ids. Directions
 * and proofs are re-keyed; evidence that points at media the clone does not
 * keep (the final render always, every take on a media-free clone) is dropped
 * with its verdict, because the clone has nothing to back it.
 */
export function remapTreatmentForClone(treatment, sceneIdMap, { includeGeneratedMedia, sourceRenderId, sourceScenesFingerprint, cloneScenesFingerprint }) {
  const t = normalizeTreatment(treatment);
  if (!t) return treatment ?? null;
  const remap = (id) => sceneIdMap.get(id) ?? id;
  return {
    ...t,
    shotDirections: t.shotDirections.map((d) => ({ ...d, sceneId: remap(d.sceneId) })),
    proofs: t.proofs.map((p) => {
      const lost = !includeGeneratedMedia || (p.evidence?.videoHistoryId && p.evidence.videoHistoryId === sourceRenderId);
      return {
        ...p,
        sceneIds: p.sceneIds.map(remap),
        ...(lost ? { status: 'proposed', evidence: null } : {}),
      };
    }),
    // The scene-set fingerprint covers ids; keep a clean basis clean.
    basis: t.basis && t.basis.scenes === sourceScenesFingerprint
      ? { ...t.basis, scenes: cloneScenesFingerprint }
      : t.basis,
  };
}

/** Scene-set fingerprint — shared by treatmentBasis and the clone remap. */
export function scenesFingerprint(scenes) {
  return treatmentBasis({ scenes }).scenes;
}
