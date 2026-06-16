/**
 * Pipeline — Series Concept Generator.
 *
 * Given a universe, asks the configured LLM to invent a NEW series that lives
 * in that world but tells a different story from any series already in it — a
 * fresh name, logline, premise, and a recommended Vonnegut story shape. The
 * universe (premise, style, influences, canon) is the seed; the universe's
 * existing series (names + loglines) are passed so the model deliberately
 * diverges from them.
 *
 * Unlike `generateSeriesTitleLogo` this does NOT persist anything — it returns
 * a concept that the New Series form pre-fills so the user can edit before
 * committing. Throws ServerError(502, PIPELINE_SERIES_CONCEPT_EMPTY) on
 * unusable output — matches the other refine helpers' error shape so the UI
 * surfaces a uniform "try again" toast.
 */

import { getUniverse, joinInfluenceList } from '../universeBuilder.js';
import { listSeries, NAME_MAX, LOGLINE_MAX, PREMISE_MAX } from './series.js';
import { ARC_SHAPES, ARC_SHAPE_IDS } from '../../lib/storyArc.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { ServerError } from '../../lib/errorHandler.js';

const CANON_LIST_MAX = 24; // cap per canon kind in the brief — keeps the prompt tight
const EXISTING_SERIES_MAX = 30;

// Render a universe canon list (characters / places / objects) as a compact
// "Name — role; Name — role" string the LLM can scan. Empty / nameless entries
// drop out; an empty (or all-nameless) list becomes an explicit "(none)" so the
// prompt never renders a dangling label.
function renderCanonList(entries) {
  const rendered = (Array.isArray(entries) ? entries : [])
    .slice(0, CANON_LIST_MAX)
    .map((e) => {
      const name = (e?.name || '').trim();
      if (!name) return null;
      const role = (e?.role || '').trim();
      return role ? `${name} — ${role}` : name;
    })
    .filter(Boolean)
    .join('; ');
  return rendered || '(none catalogued yet)';
}

const SHAPES_BLOCK = ARC_SHAPES
  .map((s) => `- \`${s.id}\` (${s.label}): ${s.description}`)
  .join('\n');

function buildContext(universe, existingSeries) {
  const existing = (existingSeries || [])
    .slice(0, EXISTING_SERIES_MAX)
    .map((s) => {
      const name = (s?.name || '').trim();
      if (!name) return null;
      const logline = (s?.logline || '').trim();
      return logline ? `- "${name}" — ${logline}` : `- "${name}"`;
    })
    .filter(Boolean);
  return {
    universe: {
      name: (universe.name || '').slice(0, 200),
      premise: (universe.premise || '').slice(0, 4000),
      logline: (universe.logline || '').slice(0, 500),
      styleNotes: (universe.styleNotes || '').slice(0, 4000),
      embrace: joinInfluenceList(universe.influences?.embrace) || '(none)',
      avoid: joinInfluenceList(universe.influences?.avoid) || '(none)',
    },
    characters: renderCanonList(universe.characters),
    places: renderCanonList(universe.places),
    objects: renderCanonList(universe.objects),
    shapes: SHAPES_BLOCK,
    existingSeries: existing.length
      ? existing.join('\n')
      : '(none yet — this is the first series in the universe)',
  };
}

export async function generateSeriesConcept(universeId, options = {}) {
  const universe = await getUniverse(universeId);
  const all = await listSeries().catch(() => []);
  const existingSeries = all.filter((s) => s.universeId === universeId);
  const emptyError = {
    code: 'PIPELINE_SERIES_CONCEPT_EMPTY',
    message: 'LLM returned an empty series concept — try again or pick a different provider.',
  };
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'pipeline-series-generate',
    variables: buildContext(universe, existingSeries),
    options,
    source: 'pipeline-series-generate',
    logTag: `Series concept — universe=${universeId.slice(0, 8)}`,
    emptyError,
    // A concept with no name is unusable — the create form needs a title. The
    // other fields are clamped/defaulted below, so name is the only hard gate.
    validateContent: (c) => {
      const name = typeof c?.name === 'string' ? c.name.trim() : '';
      if (!name) {
        throw new ServerError('LLM returned a series concept with no name — try again.', {
          status: 502, code: emptyError.code,
        });
      }
    },
  });
  const name = content.name.trim().slice(0, NAME_MAX);
  const logline = typeof content.logline === 'string' ? content.logline.trim().slice(0, LOGLINE_MAX) : '';
  const premise = typeof content.premise === 'string' ? content.premise.trim().slice(0, PREMISE_MAX) : '';
  // Drop an unrecognized shape rather than poison the form — the create path
  // already treats `null` as "no shape picked."
  const shape = typeof content.shape === 'string' && ARC_SHAPE_IDS.includes(content.shape) ? content.shape : null;
  return { name, logline, premise, shape, rationale, runId, providerId, model };
}
