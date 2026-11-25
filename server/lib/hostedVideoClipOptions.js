/** Reads clip lengths, output sizes and audio switches from the four hosted video catalogs. */

import { getFalVideoModel, falVideoResolutions } from './falVideoModels.js';
import { getRunwayVideoModel, runwayVideoResolutions } from './runwayVideoModels.js';
import { getHiggsfieldVideoModel } from './higgsfieldVideoModels.js';
import { getGoogleVideoModel } from './googleVideoModels.js';
import { coverOrLongest, durationLengths, matchResolution } from './hostedVideoClipRules.js';

function clipOptions(model, rule, resolutions, defaultResolution = null, hasAudioSwitch = false) {
  const lengths = durationLengths(rule);
  const defaultSec = rule?.defaultSec ?? null;
  return {
    model, lengths, defaultSec, resolutions, defaultResolution, hasAudioSwitch,
    coerceSeconds: (seconds) => coverOrLongest(rule, seconds),
    resolveResolution: (requested) => matchResolution(resolutions, defaultResolution, requested),
  };
}

/** Null for an uncatalogued model. Runway's text endpoint has its own size rules. */
export function hostedVideoClipOptions(backend, modelId, { mode } = {}) {
  switch (backend) {
    case 'fal': {
      const model = getFalVideoModel(modelId);
      return model && clipOptions(model, model.duration, falVideoResolutions(model), model.resolution?.default, Boolean(model.audio));
    }
    case 'runway': {
      const model = getRunwayVideoModel(modelId);
      if (!model) return null;
      // Runway's request builder always disables audio, even when the provider supports it.
      const size = mode === 'text' && model.textToVideo ? model.textToVideo.size : model.size;
      return clipOptions(model, model.duration, runwayVideoResolutions({ size }), size?.default);
    }
    case 'higgsfield': {
      const model = getHiggsfieldVideoModel(modelId);
      return model && clipOptions(model, model.duration, [...(model.resolutions ?? [])], model.defaultResolution, Boolean(model.audio));
    }
    case 'google': {
      const model = getGoogleVideoModel(modelId);
      return model && clipOptions(model, { kind: 'enum', values: model.lengths, defaultSec: model.defaultSec }, [...model.resolutions], model.defaultResolution, true);
    }
    default:
      return null;
  }
}
