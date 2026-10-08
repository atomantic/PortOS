// Server-derived style snapshots for a Music Video project's concept (#9105).
// `concept.universeStyle` / `concept.moodBoardStyle` are authored copies of the
// linked universe / mood board (bounded by the concept schema's 4000-char cap),
// so later edits to the source never silently restyle a video. The client sends
// only `concept.universeId` / `visualSpec.moodBoardId`; the create/update
// dispatcher fills the snapshot text in here.

import { collectBoardStyleContext } from '../../lib/moodBoardStyleContext.js';
import {
  getMusicVideoCharacterStyle, musicVideoCharacterStyleReferenceId, musicVideoCharacterStyleSnapshot,
  musicVideoCharacterStyleSubject, musicVideoCharacterStyleSubjectId,
} from '../../lib/musicVideoCharacterStyles.js';
import { MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES } from '../../lib/musicVideoValidation.js';
import { getCharacterStyleReferenceImage } from './characterStyles.js';

const STYLE_SNAPSHOT_MAX = 4000;

function universeStyleSnapshot(universe) {
  if (!universe) return '';
  const embrace = universe.influences?.embrace || [];
  const avoid = universe.influences?.avoid || [];
  return [
    universe.name,
    universe.styleNotes,
    embrace.length ? `Embrace: ${embrace.join(', ')}` : '',
    avoid.length ? `Avoid: ${avoid.join(', ')}` : '',
  ].filter(Boolean).join('\n').slice(0, STYLE_SNAPSHOT_MAX);
}

// Prefer the board's synthesized style (a look description with its own
// avoid list) over its raw item captions, which name the pictured places and
// subjects ("a woman sitting in a bathtub") rather than the look.
function moodBoardStyleSnapshot(board) {
  const synthesized = board?.style?.prompt?.trim();
  if (synthesized) {
    const avoid = board.style.negativePrompt?.trim();
    return [synthesized, avoid ? `Avoid: ${avoid}` : ''].filter(Boolean).join('\n').slice(0, STYLE_SNAPSHOT_MAX);
  }
  const context = board ? collectBoardStyleContext(board) : null;
  if (!context) return '';
  return [context.name, context.description, ...context.items.map((item) => Object.values(item).join('; '))]
    .filter(Boolean).join('\n').slice(0, STYLE_SNAPSHOT_MAX);
}

// A dangling or deleted source yields an empty snapshot rather than failing the
// save — the same result the client produced when its fetch found nothing.
async function loadOrEmpty(load, format, label, id) {
  try {
    return format(await load(id));
  } catch (err) {
    console.warn(`⚠️ Music Video ${label} snapshot skipped for ${id}: ${err.message}`);
    return '';
  }
}

const loadUniverse = async (id) => (await import('../universeBuilder/crud.js')).getUniverse(id);
const loadBoard = async (id) => (await import('../moodBoard/index.js')).getBoard(id);

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Returns `input` with any missing snapshot derived from the ids it carries.
 * `existing` is the stored project on a patch (null on create): a snapshot is
 * (re)derived when the id changed or none was ever stored, and never when the
 * caller supplied the snapshot text explicitly.
 */
export async function withStyleSnapshots(input, existing = null) {
  if (!input) return input;
  const concept = input.concept && typeof input.concept === 'object' ? { ...input.concept } : null;
  let visualSpec = input.visualSpec;
  let touched = false;

  if (concept && has(concept, 'universeId') && !has(concept, 'universeStyle')) {
    const id = concept.universeId || '';
    if (id !== (existing?.concept?.universeId || '') || existing?.concept?.universeStyle == null) {
      concept.universeStyle = id ? await loadOrEmpty(loadUniverse, universeStyleSnapshot, 'universe', id) : '';
      touched = true;
    }
  }

  if (concept && has(concept, 'characterStyleId') && !has(concept, 'characterStyle')) {
    const id = concept.characterStyleId || '';
    const previousId = existing?.concept?.characterStyleId || '';
    if (id !== previousId || existing?.concept?.characterStyle == null) {
      const cast = await castCharacterStyle(concept, visualSpec, existing, previousId, id);
      Object.assign(concept, cast.concept);
      visualSpec = cast.visualSpec;
      touched = true;
    }
  }

  let target = concept;
  if (has(input.visualSpec, 'moodBoardId') && !(concept && has(concept, 'moodBoardStyle'))) {
    const id = input.visualSpec.moodBoardId || '';
    if (id !== (existing?.visualSpec?.moodBoardId || '') || existing?.concept?.moodBoardStyle == null) {
      target = concept || {};
      target.moodBoardStyle = id ? await loadOrEmpty(loadBoard, moodBoardStyleSnapshot, 'mood board', id) : '';
      touched = true;
    }
  }

  if (!touched) return input;
  return { ...input, ...(target ? { concept: target } : {}), ...(visualSpec ? { visualSpec } : {}) };
}

/**
 * Picking a character style snapshots its text, casts its character as the
 * protagonist and adds this install's character sheet (if one is set) as a
 * character reference; switching away removes what the previous style added
 * and leaves every director-authored subject and reference alone.
 */
async function castCharacterStyle(concept, visualSpec, existing, previousId, id) {
  const style = id ? getMusicVideoCharacterStyle(id) : null;
  const previous = previousId ? getMusicVideoCharacterStyle(previousId) : null;

  const dropSubject = new Set([previous, style].filter(Boolean).map(musicVideoCharacterStyleSubjectId));
  let subjects = (concept.subjects ?? existing?.concept?.subjects ?? []).filter((s) => !dropSubject.has(s.id));
  if (style) {
    // The style's character leads the cast; an existing protagonist steps back.
    subjects = [musicVideoCharacterStyleSubject(style),
      ...subjects.map((s) => (s.role === 'protagonist' ? { ...s, role: 'supporting' } : s))].slice(0, 24);
  }

  const dropRef = new Set([previous, style].filter(Boolean).map(musicVideoCharacterStyleReferenceId));
  const baseRefs = visualSpec?.references ?? existing?.visualSpec?.references ?? [];
  let references = baseRefs.filter((ref) => !dropRef.has(ref.id));
  const imageId = style ? await getCharacterStyleReferenceImage(style.id) : null;
  if (imageId && references.length < 24) {
    const conditioning = references.filter((ref) => ref.condition).length;
    references = [...references, {
      id: musicVideoCharacterStyleReferenceId(style),
      imageId,
      role: 'character',
      label: `${style.character.name} character sheet`,
      use: 'reference',
      condition: conditioning < MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES,
    }];
  }
  const referencesChanged = references.length !== baseRefs.length || references.some((ref, i) => ref !== baseRefs[i]);

  return {
    concept: { characterStyle: musicVideoCharacterStyleSnapshot(style), subjects },
    visualSpec: referencesChanged ? { ...(visualSpec || {}), references } : visualSpec,
  };
}
