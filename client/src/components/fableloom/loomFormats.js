/** FableLoom format labels, option hints and episode rewrite counts for the editor. */

import { asLoomFormat, LOOM_FORMATS as FORMAT_IDS, sceneNeedsReformat } from '../../../../server/lib/fableLoomFormats.js';

const FORMAT_PRESENTATION = {
  prose: { label: 'Narrated prose', hint: 'Second-person interactive fiction — flowing paragraphs.' },
  teleplay: { label: 'Teleplay', hint: 'Sluglines, action lines, and character cues, in screenplay format.' },
};

export const LOOM_FORMATS = FORMAT_IDS.map((id) => ({ id, ...FORMAT_PRESENTATION[id] }));

export const loomFormatLabel = (id) => FORMAT_PRESENTATION[asLoomFormat(id)]?.label;
export const loomFormatHint = (id) => FORMAT_PRESENTATION[asLoomFormat(id)]?.hint;

/** The one format predicate — display, editor typography, and badges share it. */
export const isTeleplayFormat = (id) => id === 'teleplay';

export { sceneNeedsReformat };

/**
 * The episodes a rewrite still has work in, with their pending scene counts.
 * The rewrite is one request per episode, so this is the walk the drawer makes
 * and the denominator of its progress line.
 */
export const episodesNeedingReformat = (loom, format) => (loom?.episodes || [])
  .map((episode) => ({
    episode,
    sceneCount: episode.nodes.filter((n) => sceneNeedsReformat(n, format)).length,
  }))
  .filter((e) => e.sceneCount > 0);
