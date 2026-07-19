// Treadmill helpers for rigged GLB animation clips.
//
// A "root-motion" clip (a walk/run cycle that translates the model forward)
// drifts a fixed-frame avatar out of view. These helpers synthesize an
// "in place" variant — the same clip with its root-translation (`.position`)
// tracks stripped — so the gait still animates via the joint-rotation tracks
// without translating: the classic treadmill technique.
//
// Pure and framework-agnostic: they operate on any AnimationClip-shaped object
// ({ name, tracks, clone() }), so the caller supplies the set of root-motion
// clip names and the naming suffix rather than this module importing them.
// Consumed by the CoS Muse avatar (client/src/components/cos/MuseCoSAvatar.jsx).

// Route a clip name to its in-place variant: root-motion clips become
// `${name}${suffix}`, everything else is returned unchanged. Used both to name
// the synthesized variant and to look it up when resolving a montage step, so
// callers never hand-decorate clip names.
export function inPlaceClipName(name, rootMotionNames, suffix) {
  return rootMotionNames.includes(name) ? `${name}${suffix}` : name;
}

// Return `clips` plus an in-place variant of each root-motion clip. Originals
// are left untouched (they are typically shared from a loader cache); each
// variant is a clone renamed via `inPlaceClipName` with its `.position` tracks
// removed. A non-array input yields `[]`.
export function withInPlaceClips(clips, rootMotionNames, suffix) {
  if (!Array.isArray(clips)) return [];
  const out = clips.slice();
  for (const clip of clips) {
    if (!rootMotionNames.includes(clip.name)) continue;
    const inPlace = clip.clone();
    inPlace.name = inPlaceClipName(clip.name, rootMotionNames, suffix);
    inPlace.tracks = inPlace.tracks.filter((t) => !t.name.endsWith('.position'));
    out.push(inPlace);
  }
  return out;
}
