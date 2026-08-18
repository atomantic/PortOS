/**
 * Clip inventory and playback gate for an already-validated Three.js scene spec.
 *
 * The schema (`server/lib/threejsModel.js`) proves a declared `animation` block
 * is well FORMED: sequences point at real parts, stay inside their clip, never
 * fight each other for the same channel, and never fire a cue without moving
 * anything. What this reports is what the model actually DECLARED — how many
 * clips, which roles, how much of the assembly moves — so the record carries a
 * durable answer and the workspace can say "static assembly" versus "3 clips"
 * without re-deriving it from the spec on every read.
 *
 * Alongside the inventory it reports the ways a well-formed clip still plays
 * badly, which no schema rule can reach: a clip authored against a pose the
 * assembly does not build jumps the instant it opens, a chain whose handover
 * misses jumps mid-clip, a looping clip that ends somewhere else pops on every
 * repeat. Those are `findings`, and `buildThreejsAnimationFeedback` turns them
 * into refinement feedback the same way the coverage and material gates do.
 *
 * It reports rather than rejects, and it never claims skinning: PortOS builds
 * static assemblies plus declared motion, not skeletons or bind poses. Every
 * finding is a `warning` for the same reason — a static assembly is a complete
 * answer, and a deliberately odd clip is the author's to keep.
 */

import { listSpecNames } from './threejsModel.js';

// Channels a part authors in `parts`, so a clip's opening pose can be compared
// against what the assembly actually builds. `opacity` and `visible` have no
// authored counterpart on a part (opacity lives on the shared material), so
// they are only ever compared clip-internally.
const POSED_CHANNELS = ['position', 'rotationDegrees', 'scale'];
const ALL_CHANNELS = [...POSED_CHANNELS, 'opacity', 'visible'];
// Authored endpoints are provider-written decimals, so an exact compare would
// report `0.30000000000000004` as a jump. This is well below anything visible
// at PortOS's scale (a spec's whole subject fits in single-digit units).
const POSE_EPSILON = 1e-4;
// A clip is allowed to hold its final pose — a deploy that lands and rests
// reads better than one that cuts. What is reported is a window whose motion is
// over before it is half spent AND that then sits still for a noticeable time,
// which is an authored duration that does not match the clip inside it.
const DEAD_TAIL_SHARE = 0.5;
const DEAD_TAIL_SECONDS = 1.5;
// One joint is a root and nothing else (mirrors `threejsModelRig.js`); a graph
// with something to move against it, and no clip anywhere, declares motion the
// model never demonstrates.
const MIN_JOINTS_EXPECTING_MOTION = 2;

const indexParts = (parts, into = new Map()) => {
  for (const part of parts || []) {
    into.set(part.id, part);
    indexParts(part.children, into);
  }
  return into;
};

const sameValue = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, axis) => Math.abs(value - b[axis]) <= POSE_EPSILON);
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= POSE_EPSILON;
  return a === b;
};

const formatValue = (value) => (Array.isArray(value) ? `[${value.join(', ')}]` : String(value));

const partLabel = (part, partId) => part?.name || partId;

/**
 * Every sequence that drives one part+channel, in time order. The schema already
 * forbids two of them overlapping, so the order is total and the list reads as
 * the handover chain it is.
 */
function groupChannelChains(clip) {
  const chains = new Map();
  for (const sequence of clip.sequences || []) {
    for (const channel of ALL_CHANNELS) {
      const range = sequence.channels?.[channel];
      if (!range) continue;
      const key = `${sequence.partId}|${channel}`;
      const chain = chains.get(key) || { partId: sequence.partId, channel, entries: [] };
      chain.entries.push({ sequence, range });
      chains.set(key, chain);
    }
  }
  for (const chain of chains.values()) {
    chain.entries.sort((a, b) => a.sequence.startSeconds - b.sequence.startSeconds);
  }
  return [...chains.values()];
}

function evaluateClipFindings(clip, partsById) {
  const findings = [];
  const chains = groupChannelChains(clip);
  const clipLabel = clip.name || clip.id;

  const startMismatches = [];
  const handoverJumps = [];
  const loopGaps = [];

  for (const chain of chains) {
    const part = partsById.get(chain.partId);
    const label = partLabel(part, chain.partId);
    const first = chain.entries[0];
    const last = chain.entries[chain.entries.length - 1];

    // The assembled pose is the model the user is looking at. A clip whose first
    // sequence starts somewhere else teleports the part the moment the clip is
    // opened, before a single frame has played.
    if (POSED_CHANNELS.includes(chain.channel) && part && !sameValue(first.range.from, part[chain.channel])) {
      startMismatches.push(`${label}.${chain.channel} opens at ${formatValue(first.range.from)} but the assembly builds it at ${formatValue(part[chain.channel])}`);
    }

    for (let index = 1; index < chain.entries.length; index += 1) {
      const previous = chain.entries[index - 1];
      const current = chain.entries[index];
      if (sameValue(previous.range.to, current.range.from)) continue;
      handoverJumps.push(`${label}.${chain.channel} ends ${previous.sequence.id} at ${formatValue(previous.range.to)} and starts ${current.sequence.id} at ${formatValue(current.range.from)}`);
    }

    // A loop that does not close is the one defect playback makes worse the
    // longer it runs: every repeat snaps the part back across the whole gap.
    if (clip.loop && !sameValue(last.range.to, first.range.from)) {
      loopGaps.push(`${label}.${chain.channel} ends at ${formatValue(last.range.to)} and restarts at ${formatValue(first.range.from)}`);
    }
  }

  if (startMismatches.length > 0) {
    findings.push({
      code: 'clip-start-pose-mismatch',
      severity: 'warning',
      message: `clip ${clipLabel} is authored against a pose the assembly does not build, so the model jumps the instant the clip opens: ${listSpecNames(startMismatches)}`,
    });
  }
  if (handoverJumps.length > 0) {
    findings.push({
      code: 'clip-sequence-jump',
      severity: 'warning',
      message: `clip ${clipLabel} hands a channel between sequences that do not meet, so the part jumps mid-clip: ${listSpecNames(handoverJumps)}`,
    });
  }
  if (loopGaps.length > 0) {
    findings.push({
      code: 'loop-does-not-close',
      severity: 'warning',
      message: `clip ${clipLabel} loops but does not return to where it began, so it snaps on every repeat: ${listSpecNames(loopGaps)}`,
    });
  }
  // An idle is ambient repetition by definition. Authored as a one-shot it plays
  // through once and the model sits frozen in its final pose.
  if (clip.role === 'idle' && !clip.loop) {
    findings.push({
      code: 'idle-clip-does-not-loop',
      severity: 'warning',
      message: `clip ${clipLabel} is an idle but does not loop, so it plays once and freezes in its end pose`,
    });
  }

  const lastEnd = (clip.sequences || []).reduce((latest, sequence) => Math.max(latest, sequence.endSeconds), 0);
  const tail = clip.durationSeconds - lastEnd;
  if (tail >= DEAD_TAIL_SECONDS && lastEnd <= clip.durationSeconds * DEAD_TAIL_SHARE) {
    findings.push({
      code: 'clip-holds-still',
      severity: 'warning',
      message: `clip ${clipLabel} finishes moving at ${lastEnd}s and then holds still for ${Number(tail.toFixed(2))}s of its ${clip.durationSeconds}s duration`,
    });
  }

  return findings;
}

function evaluateAnimationFindings(spec) {
  const animation = spec?.animation || null;
  const joints = Array.isArray(spec?.articulation?.joints) ? spec.articulation.joints : [];

  if (!animation) {
    // Narrow on purpose: a static object declares no joints and gets no finding,
    // so nothing here pushes every model toward motion it never showed.
    if (joints.length >= MIN_JOINTS_EXPECTING_MOTION) {
      return [{
        code: 'articulation-without-clips',
        severity: 'warning',
        message: `the spec declares an articulation graph over ${joints.length} joints but no animation clip, so nothing demonstrates the motion it describes`,
      }];
    }
    return [];
  }

  const partsById = indexParts(spec?.parts);
  const clips = Array.isArray(animation.clips) ? animation.clips : [];
  const findings = clips.flatMap((clip) => evaluateClipFindings(clip, partsById));

  const firedCueIds = new Set(
    clips.flatMap((clip) => (clip.sequences || []).map((sequence) => sequence.cueId).filter(Boolean))
  );
  const unfired = (animation.cues || []).filter((cue) => !firedCueIds.has(cue.id));
  if (unfired.length > 0) {
    findings.push({
      code: 'unfired-cue',
      severity: 'warning',
      message: `${unfired.length} declared sound ${unfired.length === 1 ? 'cue is' : 'cues are'} never fired by any sequence, so a host is asked to supply a sound nothing plays: ${listSpecNames(unfired.map((cue) => cue.label || cue.id))}`,
    });
  }

  return findings;
}

/**
 * @param {object|null} spec a spec that has already passed a sculpt-spec schema
 * @returns {{animated: boolean, clipCount: number, cueCount: number, sequenceCount: number,
 *   movingPartCount: number, longestClipSeconds: number, findings: Array<{code: string,
 *   severity: string, message: string}>, warningCount: number,
 *   clips: Array<{id: string, name: string, role: string, durationSeconds: number,
 *   sequenceCount: number, cueCount: number}>}}
 */
export function summarizeThreejsAnimation(spec) {
  const animation = spec?.animation || null;
  const clips = Array.isArray(animation?.clips) ? animation.clips : [];
  const cues = Array.isArray(animation?.cues) ? animation.cues : [];
  const movingPartIds = new Set();
  let sequenceCount = 0;
  let longestClipSeconds = 0;

  const summaries = clips.map((clip) => {
    const sequences = Array.isArray(clip.sequences) ? clip.sequences : [];
    sequenceCount += sequences.length;
    // Duration is the authored window, not the last sequence's end: a clip is
    // allowed to hold its final pose after everything has finished moving.
    if (Number.isFinite(clip.durationSeconds) && clip.durationSeconds > longestClipSeconds) {
      longestClipSeconds = clip.durationSeconds;
    }
    for (const sequence of sequences) movingPartIds.add(sequence.partId);
    return {
      id: clip.id,
      name: clip.name,
      role: clip.role || 'custom',
      durationSeconds: clip.durationSeconds,
      sequenceCount: sequences.length,
      // Distinct cues, not sequences carrying one: the same latch firing in
      // four places is one sound the host has to supply, and reporting four
      // would overstate what the clip asks for.
      cueCount: new Set(sequences.map((sequence) => sequence.cueId).filter(Boolean)).size,
    };
  });

  const findings = evaluateAnimationFindings(spec);

  return {
    animated: summaries.length > 0,
    clipCount: summaries.length,
    cueCount: cues.length,
    sequenceCount,
    // Parts a clip actually drives, across every clip — the honest measure of
    // how much of the assembly is more than scenery.
    movingPartCount: movingPartIds.size,
    longestClipSeconds,
    findings,
    warningCount: findings.filter((finding) => finding.severity === 'warning').length,
    clips: summaries,
  };
}

/**
 * Default refinement feedback for a stored clip report. Reads `findings` off the
 * record rather than re-deriving them, exactly like the coverage, cross-section,
 * penetration, and material builders — so a record written before this gate
 * shipped contributes nothing rather than throwing.
 *
 * @param {object|null} animation a stored `summarizeThreejsAnimation` result
 * @returns {string} '' when there is nothing to ask for
 */
export function buildThreejsAnimationFeedback(animation) {
  const warnings = (animation?.findings || []).filter((finding) => finding.severity === 'warning');
  if (warnings.length === 0) return '';
  return [
    'The previous pass declared animation clips that will not play cleanly:',
    ...warnings.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Author every clip against the assembled pose: the first sequence on a part starts from exactly the position, rotation, and scale that part carries in "parts", each following sequence starts where the one before it ended, a looping clip returns to where it began, and the clip\'s duration ends when its motion does.',
  ].join('\n');
}
