/**
 * Clip inventory for an already-validated Three.js scene spec.
 *
 * The schema (`server/lib/threejsModel.js`) proves a declared `animation` block
 * is well FORMED: sequences point at real parts, stay inside their clip, never
 * fight each other for the same channel, and never fire a cue without moving
 * anything. What this reports is what the model actually DECLARED — how many
 * clips, which roles, how much of the assembly moves — so the record carries a
 * durable answer and the workspace can say "static assembly" versus "3 clips"
 * without re-deriving it from the spec on every read.
 *
 * It reports rather than rejects, and it never claims skinning: PortOS builds
 * static assemblies plus declared motion, not skeletons or bind poses.
 */

/**
 * @param {object|null} spec a spec that has already passed a sculpt-spec schema
 * @returns {{animated: boolean, clipCount: number, cueCount: number, sequenceCount: number,
 *   movingPartCount: number, longestClipSeconds: number, clips: Array<{id: string, name: string,
 *   role: string, durationSeconds: number, sequenceCount: number, cueCount: number}>}}
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

  return {
    animated: summaries.length > 0,
    clipCount: summaries.length,
    cueCount: cues.length,
    sequenceCount,
    // Parts a clip actually drives, across every clip — the honest measure of
    // how much of the assembly is more than scenery.
    movingPartCount: movingPartIds.size,
    longestClipSeconds,
    clips: summaries,
  };
}
