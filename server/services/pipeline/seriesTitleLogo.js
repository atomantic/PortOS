/**
 * Pipeline — Series Title / Logo Designer.
 *
 * Runs the `pipeline-series-title-logo` stage prompt against a series + its
 * linked universe to design the masthead/logo typography for cover art and
 * TV title screens. The result is persisted to `series.titleLogo` and
 * surfaced into `composeComicCoverPrompt` / `composeVolumeCoverPrompt` as the
 * "logo design" cue, replacing the generic "bold comic-book logo typography"
 * fallback when present.
 *
 * Throws ServerError(502, PIPELINE_TITLE_LOGO_EMPTY) on empty LLM output —
 * matches the other refine helpers' error shape so the UI can surface a
 * uniform "try again" toast.
 */

import { getSeries, updateSeries, TITLE_LOGO_MAX } from './series.js';
import { getUniverse, joinInfluenceList } from '../universeBuilder.js';
import { runPromptRefine } from './refineHelpers.js';

function buildContext(series, universe) {
  return {
    series: {
      name: (series.name || '').slice(0, 200),
      logline: (series.logline || '').slice(0, 500),
      styleNotes: (series.styleNotes || '').slice(0, 4000),
    },
    hasUniverse: !!universe,
    universe: {
      premise: (universe?.premise || '').slice(0, 2000),
      embrace: joinInfluenceList(universe?.influences?.embrace) || '(none)',
      avoid: joinInfluenceList(universe?.influences?.avoid) || '(none)',
    },
  };
}

export async function generateSeriesTitleLogo(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  const universe = series.universeId
    ? await getUniverse(series.universeId).catch(() => null)
    : null;
  const { refined, rationale, runId, providerId, model } = await runPromptRefine({
    templateName: 'pipeline-series-title-logo',
    variables: buildContext(series, universe),
    options,
    source: 'pipeline-series-title-logo',
    logTag: `Series title-logo — series=${seriesId.slice(0, 8)}`,
    resultField: 'titleLogo',
    emptyError: {
      code: 'PIPELINE_TITLE_LOGO_EMPTY',
      message: 'LLM returned an empty titleLogo — try again or pick a different provider.',
    },
  });
  const titleLogo = refined.slice(0, TITLE_LOGO_MAX);
  const updated = await updateSeries(seriesId, { titleLogo });
  return { series: updated, titleLogo, rationale, runId, providerId, model };
}
