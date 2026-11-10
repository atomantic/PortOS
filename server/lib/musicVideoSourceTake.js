/**
 * Shared takes for music-video shots (#15588).
 *
 * A non-adjacent return names the scene whose clip it plays (`sourceTake`).
 * The offset is seconds into that clip; when it is omitted, song time since
 * the clip owner started is the window, so time keeps passing while other
 * shots are on screen. The pointer is live: changing the owner's clip updates
 * every return. A return does not render its own frame or clip.
 *
 * Adjacent runs stay on sequence coverage (one request, then the completion
 * hook cuts the clip onto each scene). This module only suggests that opt-in.
 *
 * Pure, and it does not import shot timing: shot timing imports this module
 * for the length a source clip must cover.
 */

const EPS = 1e-6;
const round3 = (n) => Math.round(n * 1000) / 1000;
// Same bounds as CLIP_LENGTH_SEC_RANGE. Duplicated so this module stays free of shot timing.
const CLIP_LENGTH_MIN = 1;
const CLIP_LENGTH_MAX = 60;

const sceneKey = (scene) => scene?.sceneId ?? scene?.id ?? null;

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** `{ sceneId, offsetSec? }` or null. A self-link is not a take. */
function sourceTakeOf(scene) {
  const take = scene?.sourceTake;
  if (!take || typeof take !== 'object' || Array.isArray(take)) return null;
  const sceneId = typeof take.sceneId === 'string' ? take.sceneId.trim() : '';
  if (!sceneId || sceneId === sceneKey(scene)) return null;
  const offset = finite(take.offsetSec);
  return offset != null && offset >= 0 ? { sceneId, offsetSec: offset } : { sceneId };
}

export const isContinuingScene = (scene) => sourceTakeOf(scene) != null;

const spanOf = (scene) => {
  const start = finite(scene?.startSec);
  const end = finite(scene?.endSec);
  return start != null && end != null && end > start ? end - start : null;
};

const indexScenes = (scenes) => {
  const byId = new Map();
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const id = sceneKey(scene);
    if (id && !byId.has(id)) byId.set(id, scene);
  }
  return byId;
};

/**
 * The clip a continuing scene plays, or null when the link is missing or
 * cycles. An explicit offset is into the named scene's clip; a named scene
 * that is itself a return adds that hop's resolved start. An omitted offset
 * is song time since the clip owner started.
 *
 * `{ source, offsetSec, inSec, outSec, videoHistoryId, referenceImageId }`.
 */
export function resolveSourceTake(scene, scenes) {
  const take = sourceTakeOf(scene);
  const span = spanOf(scene);
  if (!take || span == null) return null;
  const byId = indexScenes(scenes);
  const named = byId.get(take.sceneId);
  if (!named) return null;
  const seen = new Set([sceneKey(scene)]);
  let owner = named;
  while (sourceTakeOf(owner)) {
    const nextId = sourceTakeOf(owner).sceneId;
    if (seen.has(nextId)) return null;
    seen.add(nextId);
    const next = byId.get(nextId);
    if (!next) return null;
    owner = next;
  }
  let offsetSec;
  if (take.offsetSec != null) {
    if (owner === named) offsetSec = take.offsetSec;
    else {
      const hop = resolveSourceTake(named, scenes);
      if (!hop) return null;
      offsetSec = hop.inSec + take.offsetSec;
    }
  } else {
    const start = finite(scene.startSec);
    const ownerStart = finite(owner.startSec);
    offsetSec = start != null && ownerStart != null ? Math.max(0, start - ownerStart) : 0;
  }
  offsetSec = round3(Math.max(0, offsetSec));
  const text = (value) => (typeof value === 'string' && value ? value : null);
  return {
    source: owner,
    offsetSec,
    inSec: offsetSec,
    outSec: round3(offsetSec + span),
    videoHistoryId: text(owner.videoHistoryId),
    referenceImageId: text(owner.referenceImageId),
  };
}

/**
 * Seconds the owner's clip must cover: its own span, and the end of every
 * return whose clip owner is this scene. Null when nothing is timed.
 */
export function sourceClipNeedSec(scene, scenes) {
  const id = sceneKey(scene);
  if (!id) return null;
  let need = spanOf(scene);
  for (const other of Array.isArray(scenes) ? scenes : []) {
    if (sceneKey(other) === id) continue;
    const resolved = resolveSourceTake(other, scenes);
    if (!resolved || sceneKey(resolved.source) !== id) continue;
    if (need == null || resolved.outSec > need) need = resolved.outSec;
  }
  return need;
}

/** The history id playback should open: the owner's clip for a return, else this scene's own. */
export function scenePlayableClipId(scene, scenes) {
  if (!isContinuingScene(scene)) return scene?.videoHistoryId || null;
  return resolveSourceTake(scene, scenes)?.videoHistoryId || null;
}

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

const identityKey = (scene) => {
  const frame = textOf(scene?.framePrompt);
  if (!frame) return null;
  const camera = textOf(scene?.shotSheet?.cameraId) || textOf(scene?.camera);
  const location = textOf(scene?.shotSheet?.location);
  const listed = Array.isArray(scene?.shotSheet?.characters) ? scene.shotSheet.characters.map(textOf).filter(Boolean) : [];
  const cast = listed.length
    ? listed.slice().sort().join('\u0001')
    : textOf(scene?.characterVariant?.ingredientId) || textOf(scene?.cameoId);
  return [camera, location, cast, frame].join('\u0000');
};

const offerable = (scene) => scene?.shotMode !== 'performance'
  && (scene?.visualLayer ?? 'footage') === 'footage'
  && spanOf(scene) != null
  && identityKey(scene) != null;

/**
 * Suggestions, not edits. Adjacent same-identity shots in one section become
 * a sequence-coverage offer. Later shots of that identity, separated by other
 * shots, become source-take returns to the earliest shot. A shot already in
 * an adjacent run is not also a return. A shot that already has the suggested
 * link is left alone.
 */
export function sharedTakeOffers(scenes) {
  const ordered = (Array.isArray(scenes) ? scenes : [])
    .filter(offerable)
    .slice()
    .sort((a, b) => a.startSec - b.startSec || (a.order ?? 0) - (b.order ?? 0));
  const byIdentity = new Map();
  for (const scene of ordered) {
    const key = identityKey(scene);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(scene);
  }
  const offers = [];
  const inRun = new Set();
  for (const group of byIdentity.values()) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        run.forEach((scene) => inRun.add(sceneKey(scene)));
        if (!run.every((scene) => scene.coverage === 'sequence')) {
          offers.push({ kind: 'sequence', sceneIds: run.map(sceneKey) });
        }
      }
      run = [];
    };
    for (const scene of group) {
      const prev = run.at(-1);
      const abuts = prev && Math.abs(scene.startSec - prev.endSec) < EPS && (prev.sectionIndex ?? null) === (scene.sectionIndex ?? null);
      if (prev && !abuts) flush();
      run.push(scene);
    }
    flush();
    const sourceId = sceneKey(group[0]);
    // Sequence completion stores only each member's cut, not the uncut run.
    // That clip cannot serve a later return's offset.
    if (inRun.has(sourceId) || group[0].coverage === 'sequence') continue;
    for (const scene of group.slice(1)) {
      const id = sceneKey(scene);
      if (inRun.has(id) || sourceTakeOf(scene)?.sceneId === sourceId) continue;
      offers.push({
        kind: 'sourceTake',
        sceneId: id,
        sourceId,
        offsetSec: round3(Math.max(0, scene.startSec - group[0].startSec)),
      });
    }
  }
  return offers;
}

/** Patches `board.saveScene` can apply for one offer. Sets the source clip length when the coverage need fits the stored range. */
export function sharedTakePatches(scenes, offer) {
  if (!offer || !Array.isArray(scenes)) return [];
  if (offer.kind === 'sequence') {
    return (offer.sceneIds || []).map((sceneId) => ({ sceneId, patch: { coverage: 'sequence' } }));
  }
  if (offer.kind !== 'sourceTake') return [];
  const byId = indexScenes(scenes);
  const source = byId.get(offer.sourceId);
  if (!source || source.coverage === 'sequence' || !byId.has(offer.sceneId)) return [];
  const link = { sceneId: offer.sourceId, offsetSec: offer.offsetSec };
  const patches = [{ sceneId: offer.sceneId, patch: { sourceTake: link } }];
  const withLink = scenes.map((scene) => (sceneKey(scene) === offer.sceneId ? { ...scene, sourceTake: link } : scene));
  const need = sourceClipNeedSec(source, withLink);
  const current = finite(source.clipLengthSec) ?? 0;
  if (need != null && need >= CLIP_LENGTH_MIN && need <= CLIP_LENGTH_MAX && need > current + EPS) {
    patches.push({ sceneId: offer.sourceId, patch: { clipLengthSec: round3(need) } });
  }
  return patches;
}
