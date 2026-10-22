/** Runway workflows with video inputs, separate from text/start-frame model choices. */
export const RUNWAY_SPECIAL_VIDEO_MODELS = Object.freeze([
  { id: 'aleph2', label: 'Aleph 2', mode: 'video-edit', endpoint: 'video_to_video', promptMaxChars: 1000, prompt: 'optional', minSec: 2, maxSec: 30 },
  { id: 'act_two', label: 'Act-Two', mode: 'character-performance', endpoint: 'character_performance', promptMaxChars: 0, prompt: 'unsupported', minSec: 3, maxSec: 30 },
]);
export const getRunwaySpecialVideoModel = (id) => RUNWAY_SPECIAL_VIDEO_MODELS.find((m) => m.id === id) || null;
export const RUNWAY_SPECIAL_VIDEO_MODES = RUNWAY_SPECIAL_VIDEO_MODELS.map((m) => m.mode);
export const RUNWAY_ACT_TWO_RATIOS = ['1280:720', '720:1280', '960:960', '1104:832', '832:1104', '1584:672'];
export const RUNWAY_ALEPH_ASPECTS = ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'];

/** Semantic schema only; documentation wording/order must not retire a compatible model. */
export function runwaySpecialSchemaContract(value) {
  if (Array.isArray(value)) return value.map(runwaySpecialSchemaContract);
  if (!value || typeof value !== 'object') return value;
  const ignored = ['$schema', 'description', 'title', 'example', 'examples', 'default', 'deprecated', 'discriminator'];
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !ignored.includes(key) && !key.startsWith('x-')).map((key) => [key, runwaySpecialSchemaContract(value[key])]));
}

export function buildRunwaySpecialVideoRequest({ modelId, videoMode, videoUri, characterVideoUri, imageUri, endImageUri,
  prompt = '', negativePrompt = '', seed, targetAspectRatio, ratio, bodyControl = true, expressionIntensity = 3, sourceDuration } = {}) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'RUNWAY_MODEL_INPUT' }); };
  const model = getRunwaySpecialVideoModel(modelId);
  if (!model || (videoMode && videoMode !== model.mode)) fail('Select a Runway model matching the video workflow.');
  if (!videoUri) fail(`${model.label} needs a ${model.id === 'act_two' ? 'performance' : 'source'} video.`);
  if (endImageUri) fail(`${model.label} does not accept an end frame in this workflow.`);
  const body = { model: model.id };
  if (seed != null && seed !== '') {
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) fail('Runway seed must be an integer between 0 and 4294967295.');
    body.seed = seed;
  }
  if (model.id === 'aleph2') {
    if (characterVideoUri) fail('Aleph 2 takes one source video, not a character video.');
    if (ratio) fail('Aleph 2 preserves source resolution; use an expand aspect ratio instead.');
    const text = [prompt.trim(), negativePrompt.trim() ? `Avoid: ${negativePrompt.trim()}` : ''].filter(Boolean).join('\n');
    if (text.length > 1000) fail('Aleph 2 takes at most 1000 prompt characters, including the negative prompt.');
    body.videoUri = videoUri;
    if (text) body.promptText = text;
    if (imageUri) body.keyframes = [{ uri: imageUri, at: 0 }];
    if (targetAspectRatio) {
      if (!RUNWAY_ALEPH_ASPECTS.includes(targetAspectRatio)) fail('Unsupported Aleph 2 expand aspect ratio.');
      body.targetAspectRatio = targetAspectRatio;
    }
  } else {
    if (prompt.trim() || negativePrompt.trim()) fail('Act-Two follows the performance video and does not accept prompts.');
    if (!!imageUri === !!characterVideoUri) fail('Act-Two needs exactly one character image or character video.');
    if (targetAspectRatio) fail('Act-Two does not accept an expand aspect ratio.');
    if (typeof bodyControl !== 'boolean' || !Number.isInteger(expressionIntensity) || expressionIntensity < 1 || expressionIntensity > 5) fail('Act-Two expression intensity must be 1–5 and body control must be boolean.');
    if (ratio && !RUNWAY_ACT_TWO_RATIOS.includes(ratio)) fail('Unsupported Act-Two output canvas.');
    body.character = { type: characterVideoUri ? 'video' : 'image', uri: characterVideoUri || imageUri };
    body.reference = { type: 'video', uri: videoUri };
    body.bodyControl = bodyControl;
    body.expressionIntensity = expressionIntensity;
    if (ratio) body.ratio = ratio;
  }
  return { model, endpoint: model.endpoint, body, seconds: sourceDuration ?? null, resolution: ratio || null, estimatedCostUsd: null };
}
