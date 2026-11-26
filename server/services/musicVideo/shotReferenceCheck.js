import { createHash } from 'node:crypto';
import { activeMusicVideoSubjects, isIncludedShotReference, musicVideoReferenceSubjectIds } from '../../lib/musicVideo/musicVideoCastSelection.js';
import { listPickableImages } from '../../lib/catalog/catalogMediaLibrary.js';
import {
  musicVideoClipConditioningReferences, musicVideoClipReferenceChoices, musicVideoConditioningReferences,
  musicVideoNameInText, musicVideoPanelArtReferences, musicVideoReferenceChoices, sceneCatalogSubjectIds,
} from '../../lib/musicVideo/musicVideoConditioning.js';
import { shotNumbers } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { IMAGE_REFERENCE_REQUEST_LIMIT, MUSIC_VIDEO_CLIP_REFERENCE_REQUEST_LIMIT } from '../../lib/referenceLimits.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { readImageSidecar } from '../imageGen/sidecarStore.js';

const FRAME = 'frameReferenceIds';
const CLIP = 'clipReferenceIds';
const limitFor = { [FRAME]: IMAGE_REFERENCE_REQUEST_LIMIT, [CLIP]: MUSIC_VIDEO_CLIP_REFERENCE_REQUEST_LIMIT };
const pickLabel = { [FRAME]: 'frame', [CLIP]: 'clip' };
const nameKey = value => String(value || '').trim().toLowerCase();
// A look-around angle shares its clip's geometry with the main plate it was rendered from (#16145),
// so shots that cut between angles of one place still pick one plate.
const geometryKey = ref => ref.angle?.sourceMediaKey || ref.imageId;
// This many consecutive shots at a place on one view earn a nudge toward its other angles.
const SAME_ANGLE_RUN = 3;
const readPlateMetadata = file => resolveGalleryImage(file)
  ? readImageSidecar(file).then(({ metadata }) => metadata).catch(() => null) : null;

const namesSubject = (text, names) => names.some(name => musicVideoNameInText(text, name));
const namesProp = (text, names) => names.some((name) => {
  const unowned = name.replace(/^.*?['’]s\s+/u, '');
  return [name, unowned].some((phrase) => {
    const singular = phrase.replace(/(?:ies|s)$/i, (ending) => (ending.toLowerCase() === 'ies' ? 'y' : ''));
    const plural = /[^aeiou]y$/i.test(singular) ? singular.replace(/y$/i, 'ies') : `${singular}s`;
    return namesSubject(text, [phrase, singular, plural]);
  });
});

function replacement(scene, field, current, remove, add) {
  const ids = Array.isArray(scene[field]) ? scene[field] : current.map(ref => ref.id);
  const next = ids.flatMap(id => id === remove ? (add && !ids.includes(add) ? [add] : []) : [id]);
  if (!remove && add && !next.includes(add)) next.push(add);
  if (next.length > limitFor[field] || next.length === ids.length && next.every((id, index) => id === ids[index])) return null;
  return { [field]: next };
}

function reportRows(scene, shot) {
  const prefix = `Shot ${shot}${scene.label && scene.label !== `Shot ${shot}` ? ` · ${scene.label}` : ''}`;
  return (code, details, message, fix, patch, omit) => ({
    // Bind the action to the actual proposal so a stale click cannot select a different plate
    // or overwrite a reference edit that arrived after the report.
    id: createHash('sha256').update(JSON.stringify([scene.sceneId, code, details, patch])).digest('hex'),
    code, sceneId: scene.sceneId, shot, message: `${prefix}: ${message}`, ...(patch ? { fix, patch } : {}),
    ...(omit ? { omit: {
      id: createHash('sha256').update(JSON.stringify([scene.sceneId, code, details, 'omit', patch, omit.patch])).digest('hex'),
      ...omit,
    } } : {}),
  });
}

/** Shot takes and recorded edit inputs are evidence of a shot-derived plate. No pixel inference. */
function plateProvenance(project) {
  const shotFrames = new Set((project.scenes || []).flatMap(scene => [
    scene.referenceImageId, scene.endImageId, ...(scene.photoSequence?.imageIds || []),
    ...(scene.takes || []).filter(take => ['image', 'endImage'].includes(take.kind)).map(take => take.assetId),
  ]).filter(Boolean));
  const fromShot = async (file) => {
    if (!shotFrames.size) return false;
    if (shotFrames.has(file)) return true;
    const metadata = await readPlateMetadata(file);
    const editSource = /^\s*(edit|refine|recreate)\b/i.test(metadata?.prompt || '') && metadata?.referenceImageFilenames?.[0];
    return [metadata?.initImageFilename, metadata?.regenOf, editSource].some(source => shotFrames.has(source));
  };
  const checked = new Map();
  return (file) => {
    if (!checked.has(file)) checked.set(file, fromShot(file));
    return checked.get(file);
  };
}

/**
 * Advisory check-in rows. Only the repair service needs the proposed reference arrays.
 * A project or scene field read here must also be in client/src/lib/musicVideoCatalogCheckinInputs.js, or the
 * shot editor will not re-read the check after an edit to it.
 */
export async function musicVideoShotReferenceChecks(project, media) {
  const scenes = project.scenes || [];
  if (!scenes.length || project.castAndSets.catalogCheckin.problems.length) return [];
  const items = project.castAndSets.catalogCheckin.items;
  const subjects = activeMusicVideoSubjects(project.concept).map((subject) => {
    const item = items.find(item => item.subjectId === subject.id);
    return { ...subject, names: [...new Set([subject.name, item?.name].filter(Boolean))] };
  });
  const cast = subjects.filter(subject => subject.kind === 'character');
  const props = subjects.filter(subject => subject.kind === 'object');
  const places = new Set(subjects.filter(subject => subject.kind === 'place').map(subject => subject.id));
  const ownerIds = new Map();
  const ownersOf = (ref) => {
    if (!ownerIds.has(ref.id)) ownerIds.set(ref.id, musicVideoReferenceSubjectIds(project, ref));
    return ownerIds.get(ref.id);
  };
  const owns = (ref, id) => ownersOf(ref).includes(id);
  const numbers = shotNumbers(project);
  const byPlace = new Map();
  const shotPicks = scenes.map((scene, index) => {
    const choices = musicVideoClipReferenceChoices(project, scene, media);
    const byId = new Map([...musicVideoPanelArtReferences(scene), ...choices].filter(ref => isIncludedShotReference(project, scene, ref)).map(ref => [ref.id, ref]));
    const readPicks = (field, automatic) => Array.isArray(scene[field]) ? scene[field].map(id => byId.get(id)).filter(Boolean) : automatic();
    const frame = readPicks(FRAME, () => musicVideoConditioningReferences(project, scene, media));
    const clip = readPicks(CLIP, () => musicVideoClipConditioningReferences(project, scene, media));
    const placeIds = new Set(sceneCatalogSubjectIds(project, scene).filter(id => places.has(id)));
    const shotPlates = [FRAME, CLIP].flatMap(field => (field === FRAME ? frame : clip)
      .filter(ref => ref.role === 'set')
      .flatMap(ref => ownersOf(ref).filter(id => places.has(id)).map(placeId => ({ field, ref, placeId }))));
    for (const placeId of new Set(shotPlates.map(pick => pick.placeId))) {
      if ((scene.shotSheet?.location || scene.setReference?.subjectId) && !placeIds.has(placeId)) continue;
      const keys = [...new Set(shotPlates.filter(pick => pick.placeId === placeId && Array.isArray(scene[pick.field])).map(pick => geometryKey(pick.ref)))].sort();
      if (!keys.length) continue;
      const group = byPlace.get(placeId) || new Set();
      group.add(JSON.stringify(keys));
      byPlace.set(placeId, group);
    }
    return { scene, choices, frame, clip, shotPlates, placeIds, row: reportRows(scene, numbers.get(scene.sceneId) ?? index + 1) };
  });
  const fromShot = plateProvenance(project);
  const pickedPlates = shotPicks.flatMap(shot => shot.shotPlates);
  const unsafe = new Set();
  const needsLatest = new Set([...byPlace].filter(([, picks]) => picks.size > 1).map(([placeId]) => placeId));
  await Promise.all(pickedPlates.map(async ({ ref, placeId }) => {
    if (await fromShot(ref.imageId)) {
      unsafe.add(ref.imageId);
      needsLatest.add(placeId);
    }
  }));
  const placeChoices = musicVideoReferenceChoices(project).filter(ref => ref.role === 'set');
  const latestEntries = await Promise.all(items.filter(item => needsLatest.has(item.subjectId)).map(async (item) => {
    const choicesByImage = new Map(placeChoices.filter(ref => ref.catalogSubjectId === item.subjectId).map(ref => [ref.imageId, ref]));
    // The media array was ordered newest-first before projecting Auto guides separately.
    for (const { mediaKey } of listPickableImages(media[item.ingredientId])) {
      const choice = choicesByImage.get(mediaKey);
      if (choice && !await fromShot(mediaKey)) return [item.subjectId, choice];
    }
    return [item.subjectId, null];
  }));
  const newest = new Map(latestEntries);
  const sameAngle = sameAngleRows(shotPicks, subjects, ownersOf);

  return shotPicks.flatMap(({ scene, choices, frame, clip, shotPlates, placeIds, row }) => {
    const omitted = scene.omittedCatalogSubjectIds || [];
    const included = subject => !omitted.includes(subject.id);
    const omit = subject => ({ label: `Remove ${subject.name} from shot`, patch: { omittedCatalogSubjectIds: [...omitted, subject.id] } });
    const sheet = scene.shotSheet;
    const listed = Array.isArray(sheet?.characters);
    const keys = new Set((listed ? sheet.characters : []).map(nameKey).filter(Boolean));
    const starts = cast.filter(subject => included(subject) && [subject.id, subject.ingredientId, ...subject.names].some(name => keys.has(nameKey(name))));
    const ends = scene.endFrameOff === true ? [] : cast.filter(subject => included(subject) && namesSubject(scene.endFramePrompt || '', subject.names));
    const needed = new Set([...starts, ...ends].map(subject => subject.id));
    const missing = [...new Set([...starts, ...ends])].filter(subject => !frame.some(ref => owns(ref, subject.id)));
    const extraCast = (field, picks) => listed && Array.isArray(scene[field]) ? picks.filter(ref => ref.role === 'character'
      && ownersOf(ref).some(id => cast.some(subject => subject.id === id)) && !ownersOf(ref).some(id => needed.has(id))) : [];
    // A pick is extra only when none of its owners belongs in the shot. A shared comparison sheet owned by
    // two characters (musicVideoReferenceSubjectIds) therefore covers both in a two-person shot, and in a
    // one-person shot it is not reported for also showing the other person: it is a likeness sheet, and
    // the reference map tells the image model to show only the people the shot calls for.
    const unexpected = extraCast(FRAME, frame);
    const preferred = subject => choices.find(ref => ref.role === 'character' && owns(ref, subject.id));
    const rows = missing.map((subject) => {
      const pick = preferred(subject);
      const swap = unexpected[0];
      const slot = starts.includes(subject) ? (ends.includes(subject) ? 'start and end frames' : 'start frame') : 'end frame';
      return row('missing-character', subject.id, `Add a character reference for ${subject.name} to the ${slot}.`,
        swap ? `Swap in ${subject.name}` : `Add ${subject.name}`, pick && replacement(scene, FRAME, frame, swap?.id, pick.id), omit(subject));
    });
    for (const ref of unexpected) {
      const subject = missing.find(candidate => preferred(candidate));
      const pick = subject && preferred(subject);
      rows.push(row('extra-character', [FRAME, ref.id], `The frame reference for ${ref.label || 'this character'} is outside the shot sheet and end frame cast.`,
        pick ? `Swap in ${subject.name}` : 'Remove character pick', replacement(scene, FRAME, frame, ref.id, pick?.id)));
    }
    for (const ref of extraCast(CLIP, clip)) {
      rows.push(row('extra-character', [CLIP, ref.id], `The clip reference for ${ref.label || 'this character'} is outside the shot sheet and end frame cast.`,
        'Remove character pick', replacement(scene, CLIP, clip, ref.id)));
    }
    const propText = [scene.framePrompt || scene.prompt, sheet?.view, sheet?.action, sheet?.notes].filter(Boolean).join(' ');
    if (Array.isArray(scene[FRAME]) || Array.isArray(scene[CLIP])) {
      for (const subject of props.filter(subject => included(subject) && namesProp(propText, subject.names))) {
        const inFrame = frame.find(ref => owns(ref, subject.id));
        const inClip = clip.find(ref => owns(ref, subject.id));
        if (Boolean(inFrame) === Boolean(inClip)) continue;
        const field = inFrame ? CLIP : FRAME;
        const label = pickLabel[field];
        rows.push(row('missing-prop', [subject.id, field], `${subject.name} has a ${pickLabel[inFrame ? FRAME : CLIP]} reference and needs a ${label} reference.`,
          `Add ${subject.name} to ${label}`, replacement(scene, field, inFrame ? clip : frame, null, (inFrame || inClip).id), omit(subject)));
      }
    }
    const place = subjects.find(subject => subject.kind === 'place' && included(subject) && subject.id === scene.setReference?.subjectId);
    if (place && !scene.setReference.greyboxShotId && Array.isArray(scene[FRAME]) && !frame.some(ref => owns(ref, place.id))) {
      const pick = choices.find(ref => ref.role === 'set' && owns(ref, place.id));
      rows.push(row('missing-place', place.id, `Add an environment reference for ${place.name} to the frame.`,
        `Add ${place.name}`, pick && replacement(scene, FRAME, frame, null, pick.id), omit(place)));
    }
    for (const { field, ref, placeId } of shotPlates) {
      const current = field === FRAME ? frame : clip;
      const latest = newest.get(placeId);
      const label = pickLabel[field];
      if (unsafe.has(ref.imageId)) {
        rows.push(row('shot-derived-plate', [field, ref.id, placeId], `The ${label} plate ${ref.imageId} comes from a shot frame and may contain cast.`,
          latest ? `Use ${latest.imageId}` : 'Remove shot-derived plate', replacement(scene, field, current, ref.id, latest?.id)));
      } else if (Array.isArray(scene[field]) && (!sheet?.location && !scene.setReference?.subjectId || placeIds.has(placeId))
        && byPlace.get(placeId)?.size > 1 && latest && geometryKey(ref) !== geometryKey(latest)) {
        rows.push(row('different-plate', [field, ref.id, placeId], `Shots at ${latest.label} pick different plates. The ${label} uses ${ref.imageId}. Newest plate: ${latest.imageId}.`,
          'Use newest plate', replacement(scene, field, current, ref.id, latest.id)));
      }
    }
    const removed = subjects.filter(subject => omitted.includes(subject.id)).map(subject =>
      row('omitted-subject', subject.id, `${subject.name} was removed from this shot's references.`, `Restore ${subject.name}`,
        { omittedCatalogSubjectIds: omitted.filter(id => id !== subject.id) }));
    return [...rows, ...(sameAngle.get(scene.sceneId) || []), ...removed];
  });
}

/** Advisory only: a run of consecutive shots at a place with angle plates that all frame it from one view. */
function sameAngleRows(shotPicks, subjects, ownersOf) {
  const withAngles = new Set(shotPicks.flatMap(({ choices }) => choices.filter(ref => ref.angle && ref.role === 'set').flatMap(ownersOf)));
  const runs = new Map();
  const out = new Map();
  for (const { scene, shotPlates, row } of shotPicks) {
    const views = new Map();
    for (const { field, ref, placeId } of shotPlates) {
      if (field === FRAME && withAngles.has(placeId)) views.set(placeId, [...(views.get(placeId) || []), ref.imageId]);
    }
    for (const placeId of withAngles) {
      if (!views.has(placeId)) { runs.delete(placeId); continue; }
      const key = JSON.stringify([...new Set(views.get(placeId))].sort());
      const run = runs.get(placeId)?.key === key ? runs.get(placeId) : { key, count: 0 };
      run.count += 1;
      runs.set(placeId, run);
      if (run.count < SAME_ANGLE_RUN) continue;
      const name = subjects.find(subject => subject.id === placeId)?.names.at(-1) || 'this place';
      out.set(scene.sceneId, [...(out.get(scene.sceneId) || []), row('same-angle', [placeId, key],
        `${run.count} shots in a row at ${name} use the same view. Pick another of its angles for variety.`)]);
    }
  }
  return out;
}
