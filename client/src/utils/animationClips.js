// Treadmill helpers for rigged GLB animation clips.
//
// `withInPlaceClips` synthesizes root-translation-stripped ("in place") variants of root-motion walk/run clips so a fixed-frame avatar can't drift out of view (the gait still animates via joint-rotation tracks); `inPlaceClipName` routes a clip name to its variant.
// Pure and framework-agnostic: they operate on any AnimationClip-shaped object ({ name, tracks, clone() }) and the caller supplies the root-motion clip names and naming suffix. Consumed by the CoS Muse avatar (client/src/components/cos/MuseCoSAvatar.jsx).

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
