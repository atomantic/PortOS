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

import { getUniverse, joinInfluenceList, ERR_NOT_FOUND as UNIVERSE_ERR_NOT_FOUND } from '../universeBuilder.js';
import { listSeries, NAME_MAX, LOGLINE_MAX, PREMISE_MAX } from './series.js';
import { ARC_SHAPES, ARC_SHAPE_IDS } from '../../lib/storyArc.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { ServerError } from '../../lib/errorHandler.js';

const CANON_LIST_MAX = 24; // cap per canon kind in the brief — keeps the prompt tight
const EXISTING_SERIES_MAX = 30;

// Render a universe canon list (characters / places / objects) as a compact
// "Name — role; Name — role" string the LLM can scan. Entries with no
// identifier drop out; an empty (or all-unidentified) list becomes an explicit
// "(none)" so the prompt never renders a dangling label.
function renderCanonList(entries) {
  const rendered = (Array.isArray(entries) ? entries : [])
    .slice(0, CANON_LIST_MAX)
    .map((e) => {
      // Places may carry only a `slugline` and no `name` — the bible sanitizer
      // accepts either as the identifier (storyBible.js), so fall back to it.
      // Characters/objects always have a name, so the fallback is a no-op there.
      const label = (e?.name || e?.slugline || '').trim();
      if (!label) return null;
      const role = (e?.role || '').trim();
      return role ? `${label} — ${role}` : label;
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
  // getUniverse throws the universe service's generic NOT_FOUND code, which the
  // pipeline route's mapServiceError doesn't translate — leaving a stale/deleted
  // universeId to surface as a 500. Translate it here to a proper 404 so bad
  // user input reads as bad input, not a server fault.
  const universe = await getUniverse(universeId).catch((err) => {
    if (err?.code === UNIVERSE_ERR_NOT_FOUND) {
      throw new ServerError(`Universe not found: ${universeId} — pick an existing universe.`, {
        status: 404, code: 'PIPELINE_SERIES_CONCEPT_UNIVERSE_NOT_FOUND',
      });
    }
    throw err;
  });
  // Let a storage failure propagate (→ 500) rather than swallowing it: a
  // silently-empty list would feed the model a "no existing series" brief for a
  // universe that actually has some, weakening duplicate-avoidance while still
  // reporting success.
  const all = await listSeries();
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
