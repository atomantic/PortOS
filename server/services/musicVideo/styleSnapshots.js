// Server-derived style snapshots for a Music Video project's concept (#9105).
// `concept.universeStyle` / `concept.moodBoardStyle` are authored copies of the
// linked universe / mood board (bounded by the concept schema's 4000-char cap),
// so later edits to the source never silently restyle a video. The client sends
// only `concept.universeId` / `visualSpec.moodBoardId`; the create/update
// dispatcher fills the snapshot text in here.

import { collectBoardStyleContext } from '../../lib/moodBoardStyleContext.js';

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

function moodBoardStyleSnapshot(board) {
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
  let touched = false;

  if (concept && has(concept, 'universeId') && !has(concept, 'universeStyle')) {
    const id = concept.universeId || '';
    if (id !== (existing?.concept?.universeId || '') || existing?.concept?.universeStyle == null) {
      concept.universeStyle = id ? await loadOrEmpty(loadUniverse, universeStyleSnapshot, 'universe', id) : '';
      touched = true;
    }
  }

  if (has(input.visualSpec, 'moodBoardId') && !(concept && has(concept, 'moodBoardStyle'))) {
    const id = input.visualSpec.moodBoardId || '';
    if (id !== (existing?.visualSpec?.moodBoardId || '') || existing?.concept?.moodBoardStyle == null) {
      const target = concept || {};
      target.moodBoardStyle = id ? await loadOrEmpty(loadBoard, moodBoardStyleSnapshot, 'mood board', id) : '';
      return { ...input, concept: target };
    }
  }

  return touched ? { ...input, concept } : input;
}
