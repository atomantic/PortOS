import { describe, expect, it } from 'vitest';
import {
  FAL_VIDEO_MODELS, coerceFalVideoSeconds, falVideoLengths, falVideoResolutions, resolveFalVideoResolution,
} from './falVideoModels.js';
import {
  RUNWAY_VIDEO_MODELS, coerceRunwayVideoSeconds, resolveRunwayVideoResolution, runwayVideoLengths, runwayVideoResolutions,
} from './runwayVideoModels.js';
import { HIGGSFIELD_VIDEO_MODELS, buildHiggsfieldVideoRequest, higgsfieldVideoLengths } from './higgsfieldVideoModels.js';
import { GOOGLE_VIDEO_MODELS, buildGoogleVideoRequest, coerceGoogleVideoSeconds, googleVideoLengths } from './googleVideoModels.js';
import { hostedVideoClipOptions } from './hostedVideoClipOptions.js';

const catalogs = [
  {
    backend: 'fal', models: FAL_VIDEO_MODELS, lengthsOf: falVideoLengths, coerce: coerceFalVideoSeconds,
    sizesOf: falVideoResolutions, resolve: resolveFalVideoResolution, audio: (model) => Boolean(model.audio),
  },
  {
    backend: 'runway', models: RUNWAY_VIDEO_MODELS, lengthsOf: runwayVideoLengths, coerce: coerceRunwayVideoSeconds,
    sizesOf: runwayVideoResolutions, resolve: resolveRunwayVideoResolution, audio: () => false,
  },
  {
    backend: 'higgsfield', models: HIGGSFIELD_VIDEO_MODELS, lengthsOf: higgsfieldVideoLengths,
    sizesOf: (model) => model.resolutions ?? [], audio: (model) => Boolean(model.audio),
    resolve: (model, resolution) => buildHiggsfieldVideoRequest({ modelId: model.id, resolution, prompt: 'Wind in the trees' }).resolution,
  },
  {
    backend: 'google', models: GOOGLE_VIDEO_MODELS, lengthsOf: googleVideoLengths, coerce: coerceGoogleVideoSeconds,
    sizesOf: (model) => model.resolutions, audio: () => true,
    resolve: (model, resolution) => buildGoogleVideoRequest({ modelId: model.id, resolution, prompt: 'Wind in the trees' }).resolution,
  },
];

describe.each(catalogs)('$backend clip options', ({ backend, models, lengthsOf, coerce, sizesOf, resolve, audio }) => {
  it.each(models)('describes and resolves $id', (model) => {
    const options = hostedVideoClipOptions(backend, model.id);
    const lengths = lengthsOf(model);
    const sizes = sizesOf(model);
    const defaultSec = model.duration?.defaultSec ?? model.defaultSec ?? null;
    expect(options.model).toBe(model);
    expect(options.lengths).toEqual(lengths);
    expect(options.defaultSec).toBe(defaultSec);
    expect(options.hasAudioSwitch).toBe(audio(model));
    for (const seconds of [null, 1, 5, 6, 8, 10, 30, 999]) {
      const covering = seconds == null ? defaultSec : lengths.find((length) => length >= seconds) ?? lengths.at(-1) ?? null;
      expect(options.coerceSeconds(seconds)).toBe(covering);
      if (coerce) expect(options.coerceSeconds(seconds)).toBe(coerce(model, seconds));
    }
    expect(options.resolutions).toEqual(sizes);
    expect(options.defaultResolution).toBe(resolve(model, null));
    for (const size of [null, '', 'unlisted', ...sizes]) {
      expect(options.resolveResolution(size)).toBe(resolve(model, size));
    }
    for (const size of sizes) {
      expect(options.resolveResolution(` ${size.toUpperCase()} `)).toBe(size);
    }
  });
});

it('preserves the Runway text endpoint’s distinct size choices', () => {
  const model = RUNWAY_VIDEO_MODELS.find((row) => row.textToVideo
    && Object.keys(row.textToVideo.size?.byResolution ?? {}).join() !== runwayVideoResolutions(row).join());
  const options = hostedVideoClipOptions('runway', model.id, { mode: 'text' });
  expect(options.model).toBe(model);
  expect(options.resolutions).toEqual(runwayVideoResolutions({ size: model.textToVideo.size }));
  expect(options.defaultResolution).toBe(model.textToVideo.size?.default ?? null);
});

it('keeps fractional cover semantics separate from provider submission rounding', () => {
  const fal = hostedVideoClipOptions('fal', FAL_VIDEO_MODELS[0].id);
  expect(fal.coerceSeconds(6.0000001)).toBe(6);
  expect(fal.coerceSeconds(6.1)).toBe(10);
  const higgsfield = hostedVideoClipOptions('higgsfield', HIGGSFIELD_VIDEO_MODELS[0].id);
  expect(higgsfield.coerceSeconds(5.1)).toBe(6);
  const google = hostedVideoClipOptions('google', GOOGLE_VIDEO_MODELS[0].id);
  expect(google.coerceSeconds(4.1)).toBe(6);
});

it('distinguishes uncatalogued endpoints from catalogued source-audio models', () => {
  expect(hostedVideoClipOptions('fal', 'example/custom-video')).toBeNull();
  expect(hostedVideoClipOptions('grok', 'unknown')).toBeNull();
  const model = FAL_VIDEO_MODELS.find((row) => row.duration.kind === 'audio');
  const options = hostedVideoClipOptions('fal', model.id);
  expect(options.lengths).toEqual([]);
  expect(options.coerceSeconds(10)).toBeNull();
});
