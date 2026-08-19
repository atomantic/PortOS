/**
 * The clip player PortOS emits into an exported Three.js factory.
 *
 * The exported module already carries the validated `animation` block and the
 * part node map, which is enough to drive a clip — but only if every consumer
 * re-implements the pose semantics, and any of them getting it subtly wrong
 * makes the export disagree with what the PortOS preview showed. So the export
 * ships the player too.
 *
 * It is a fixed source STRING, not a generated one: nothing a provider authored
 * is interpolated into it, and the only provider-derived text in the emitted
 * file remains `JSON.stringify(spec)`. That is what keeps "clips are data,
 * never code" true on the export path as well as inside PortOS.
 *
 * The semantics mirror `client/src/lib/threejsAnimation.js` exactly — same owner
 * ranking per part+channel, same step `visible`, same half-open cue interval, so
 * a clip poses identically in the preview and in a consumer's own scene. Change
 * one and change the other; `threejsModelPlayerSource.test.js` executes the
 * emitted player against the same expectations the client evaluator's suite
 * asserts.
 *
 * Emitted into a module that already defines `spec`, `radians`, and `rotation`.
 */
export const THREEJS_PLAYER_SOURCE = `
// ---------------------------------------------------------------------------
// Clip playback. Declared transforms over time — no skeleton, no bind pose, and
// nothing here was authored by the model provider. Mirrors the PortOS preview.
// ---------------------------------------------------------------------------

const CLIP_CHANNELS = ['position', 'rotationDegrees', 'scale', 'opacity', 'visible'];

const EASING_CURVES = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => t * t * (3 - 2 * t),
};

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

const interpolateRange = (range, progress) => (
  Array.isArray(range.from) && Array.isArray(range.to)
    ? range.from.map((value, axis) => value + ((range.to[axis] - value) * progress))
    : range.from + ((range.to - range.from) * progress)
);

// \`visible\` cannot be interpolated: the part holds \`from\` for the whole window
// and takes \`to\` the instant the sequence completes.
const stepRange = (range, progress) => (progress >= 1 ? range.to : range.from);

const channelValue = (sequence, range, channel, timeSeconds) => {
  const span = sequence.endSeconds - sequence.startSeconds;
  const progress = clamp01(span > 0 ? (timeSeconds - sequence.startSeconds) / span : 1);
  if (channel === 'visible') return stepRange(range, progress);
  const curve = EASING_CURVES[sequence.easing] || EASING_CURVES.linear;
  return interpolateRange(range, curve(progress));
};

// 2 = this window contains the instant, 1 = it is behind the playhead, 0 = ahead.
const rankAt = (sequence, time) => {
  if (time >= sequence.startSeconds && time <= sequence.endSeconds) return 2;
  return sequence.endSeconds < time ? 1 : 0;
};

const outranks = (candidate, current, time) => {
  const candidateRank = rankAt(candidate, time);
  const currentRank = rankAt(current, time);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidateRank === 2) return candidate.startSeconds > current.startSeconds;
  if (candidateRank === 1) return candidate.endSeconds > current.endSeconds;
  return candidate.startSeconds < current.startSeconds;
};

/**
 * Pose for every part a clip drives at an absolute time. Pure: the same time
 * gives the same pose whether it came from a play loop, a scrub, or a test.
 *
 * Each part+channel resolves from the one sequence that owns the instant — the
 * window containing it, else the most recent window behind it (whose \`to\` still
 * holds), else the next window ahead (whose \`from\` has not moved yet) — so a
 * part never snaps back to its authored pose in a gap, and declaration order
 * decides nothing. A part no sequence drives is absent from the pose entirely.
 */
export function evaluateSculptClipPose(clip, timeSeconds) {
  // Null-prototype: part ids come from the spec, and a bare lookup on a plain
  // object can otherwise hand back \`toString\`.
  const pose = Object.create(null);
  const sequences = Array.isArray(clip && clip.sequences) ? clip.sequences : [];
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const owners = new Map();
  for (const sequence of sequences) {
    for (const channel of CLIP_CHANNELS) {
      const range = sequence.channels && sequence.channels[channel];
      if (!range) continue;
      const key = sequence.partId + '|' + channel;
      const current = owners.get(key);
      if (!current || outranks(sequence, current.sequence, time)) {
        owners.set(key, { sequence, range, channel });
      }
    }
  }
  for (const owner of owners.values()) {
    const partPose = pose[owner.sequence.partId] || (pose[owner.sequence.partId] = {});
    partPose[owner.channel] = channelValue(owner.sequence, owner.range, owner.channel, time);
  }
  return pose;
}

/**
 * Cues whose sequence starts inside the half-open interval [fromSeconds,
 * toSeconds) — what a play loop crossed since its last frame. Half-open so
 * consecutive frames tile the timeline with no cue fired twice and none skipped.
 */
export function collectSculptCues(clip, fromSeconds, toSeconds) {
  if (!(toSeconds > fromSeconds)) return [];
  return (Array.isArray(clip && clip.sequences) ? clip.sequences : [])
    .filter((sequence) => sequence.cueId
      && sequence.startSeconds >= fromSeconds
      && sequence.startSeconds < toSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((sequence) => ({
      cueId: sequence.cueId,
      sequenceId: sequence.id,
      partId: sequence.partId,
      atSeconds: sequence.startSeconds,
    }));
}

const indexAuthoredPose = (parts, into) => {
  for (const part of parts) {
    into[part.id] = { position: part.position, rotationDegrees: part.rotationDegrees, scale: part.scale };
    indexAuthoredPose(part.children, into);
  }
  return into;
};

/**
 * Drive this model's declared clips over the node map the factory built.
 *
 * The player does NOT own an animation loop: call \`update(deltaSeconds)\` from
 * the render loop you already have, so nothing keeps ticking after you stop
 * using it. \`seek()\` scrubs silently; \`update()\` is the only thing that fires
 * cues, which is what makes a cue an identifier your host maps to its own sound
 * rather than embedded audio.
 *
 * A model with no clips yields a working no-op player (\`clips: []\`), so a
 * static assembly needs no branch at the call site.
 *
 * @param {THREE.Object3D} root the Group returned by this module's factory
 * @param {{ onCue?: (event: object) => void, speed?: number }} [options]
 */
export function createSculptAnimationPlayer(root, options) {
  const settings = options || {};
  const runtime = (root && root.userData && root.userData.sculptRuntime) || {};
  const nodes = runtime.nodes || {};
  const animation = runtime.animation || null;
  const clips = (animation && animation.clips) || [];
  const cues = (animation && animation.cues) || [];
  const cuesById = Object.create(null);
  for (const cue of cues) cuesById[cue.id] = cue;
  const authored = indexAuthoredPose(spec.parts, Object.create(null));
  // Materials are shared between parts, so driving \`opacity\` through the shared
  // instance would fade every part that happens to use it. The first opacity
  // frame swaps in a clone and remembers the original for \`restore()\`.
  const sharedMaterials = new Map();
  const posedPartIds = new Set();

  let clip = clips[0] || null;
  let timeSeconds = 0;
  let playing = false;
  let speed = Number.isFinite(settings.speed) && settings.speed > 0 ? settings.speed : 1;

  const duration = () => (clip && Number.isFinite(clip.durationSeconds) ? clip.durationSeconds : 0);

  const applyOpacity = (partId, node, opacity) => {
    if (!node.material) return;
    if (!sharedMaterials.has(partId)) {
      sharedMaterials.set(partId, node.material);
      node.material = node.material.clone();
    }
    node.material.opacity = opacity;
    node.material.transparent = sharedMaterials.get(partId).transparent || opacity < 1;
  };

  const restorePart = (partId) => {
    const node = nodes[partId];
    if (!node) return;
    const pose = authored[partId];
    if (pose) {
      node.position.set(pose.position[0], pose.position[1], pose.position[2]);
      node.rotation.set(...rotation(pose.rotationDegrees));
      node.scale.set(pose.scale[0], pose.scale[1], pose.scale[2]);
    }
    node.visible = true;
    const shared = sharedMaterials.get(partId);
    if (shared) {
      // The clone exists only for this player, so it is ours to dispose.
      if (node.material && node.material !== shared) node.material.dispose();
      node.material = shared;
      sharedMaterials.delete(partId);
    }
  };

  const applyPose = () => {
    const pose = evaluateSculptClipPose(clip, timeSeconds);
    for (const partId of Object.keys(pose)) {
      const node = nodes[partId];
      if (!node) continue;
      const partPose = pose[partId];
      posedPartIds.add(partId);
      if (partPose.position) node.position.set(partPose.position[0], partPose.position[1], partPose.position[2]);
      if (partPose.rotationDegrees) node.rotation.set(...rotation(partPose.rotationDegrees));
      if (partPose.scale) node.scale.set(partPose.scale[0], partPose.scale[1], partPose.scale[2]);
      if (typeof partPose.visible === 'boolean') node.visible = partPose.visible;
      if (typeof partPose.opacity === 'number') applyOpacity(partId, node, partPose.opacity);
    }
  };

  // Put every part this player has moved back to the pose the factory built,
  // then apply the current clip. Called when the open clip changes, because the
  // new clip drives a different set of parts and the old ones would otherwise
  // stay frozen wherever the previous clip left them.
  const reapply = () => {
    for (const partId of posedPartIds) restorePart(partId);
    posedPartIds.clear();
    applyPose();
  };

  const seekTo = (seconds) => {
    const total = duration();
    const target = Number.isFinite(seconds) ? seconds : 0;
    timeSeconds = target < 0 ? 0 : target > total ? total : target;
    applyPose();
    return timeSeconds;
  };

  const emit = (crossed) => {
    const handler = settings.onCue;
    if (typeof handler !== 'function') return;
    for (const event of crossed) {
      // A host callback must not be able to kill the caller's render loop.
      try {
        handler({ ...event, clipId: clip.id, cue: cuesById[event.cueId] || null });
      } catch (error) {
        console.error('Sculpt clip cue handler failed: ' + error.message);
      }
    }
  };

  const player = {
    clips: clips.map((entry) => ({
      id: entry.id,
      name: entry.name,
      role: entry.role,
      durationSeconds: entry.durationSeconds,
      loop: entry.loop,
    })),
    cues: cues.map((cue) => ({ ...cue })),
    get clipId() { return clip ? clip.id : null; },
    get durationSeconds() { return duration(); },
    get timeSeconds() { return timeSeconds; },
    get playing() { return playing; },
    get speed() { return speed; },
    set speed(value) { if (Number.isFinite(value) && value > 0) speed = value; },

    /**
     * Open a clip by id, stopped at its first frame. An id this model does not
     * declare falls back to the first clip, so a stale selection degrades to
     * something playable instead of an empty transport.
     */
    setClip(clipId) {
      if (clips.length === 0) return null;
      clip = clips.find((entry) => entry.id === clipId) || clips[0];
      timeSeconds = 0;
      playing = false;
      reapply();
      return clip.id;
    },

    /** Scrub. Never fires a cue — silence while dragging is the point. */
    seek: seekTo,

    play() {
      if (!clip) return false;
      // Pressing play on a finished one-shot replays it rather than sitting on
      // its last frame.
      if (!clip.loop && timeSeconds >= duration()) seekTo(0);
      playing = true;
      return true;
    },

    pause() { playing = false; },

    stop() {
      playing = false;
      seekTo(0);
    },

    /**
     * Advance the playhead by real seconds and pose the model. Returns the cues
     * crossed by this frame (also handed to \`onCue\`), oldest first.
     */
    update(deltaSeconds) {
      const total = duration();
      if (!playing || !clip || !(total > 0) || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return [];
      const from = timeSeconds;
      const raw = from + (deltaSeconds * speed);
      let crossed;
      if (raw < total) {
        crossed = collectSculptCues(clip, from, raw);
        timeSeconds = raw;
      } else if (clip.loop) {
        crossed = raw - from >= total
          // A frame gap at least as long as the whole clip — a backgrounded tab,
          // a stall — crossed every cue in it. Fire each ONCE for the gap
          // instead of replaying a backlog per skipped cycle: a resumed tab must
          // not burst N copies of the same sound, and reporting only the tail
          // and the wrapped remainder would silently drop the cues in between.
          ? collectSculptCues(clip, 0, total)
          : [...collectSculptCues(clip, from, total), ...collectSculptCues(clip, 0, raw % total)];
        timeSeconds = raw % total;
      } else {
        crossed = collectSculptCues(clip, from, total);
        timeSeconds = total;
        playing = false;
      }
      applyPose();
      emit(crossed);
      return crossed;
    },

    /**
     * Put the assembly back exactly as the factory built it, and stop. The
     * player poses the model at frame 0 of its first clip when it is created,
     * so this is how a consumer gets the un-posed assembly back.
     */
    restore() {
      playing = false;
      timeSeconds = 0;
      for (const partId of posedPartIds) restorePart(partId);
      posedPartIds.clear();
    },
  };

  // Frame 0 of the first clip, the way the preview opens a transport. Without
  // this the model would sit at its authored pose while the player reported
  // \`timeSeconds: 0\` of a clip whose opening frame hides or fades a part.
  applyPose();
  return player;
}
`;
