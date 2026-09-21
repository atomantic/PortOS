// PNG text metadata helpers for Stable Diffusion-compatible renders.
//
// The image upload path re-encodes images to PNG with sharp, which deliberately
// drops ancillary chunks. Read the bounded text chunks before that conversion so
// prompt provenance survives as structured application metadata instead of being
// lost with the source bytes.

import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_CHUNKS = 128;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TEXT_CHUNK_BYTES = 256 * 1024;

const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);
const METADATA_KEYS = new Set([
  'parameters',
  'prompt',
  'negative_prompt',
  'negative prompt',
  'negativeprompt',
  'sd-metadata',
  'sd_metadata',
  'invokeai_metadata',
  'metadata',
]);

const asBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
};

const boundedText = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, MAX_TEXT_BYTES).trim();
  return text || null;
};

const firstText = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;

const finiteNumber = (value) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const integerOrString = (value) => {
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const number = Number(trimmed);
    return Number.isSafeInteger(number) && String(number) === trimmed ? number : trimmed;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return null;
};

function addIfPresent(target, key, value) {
  if (value === null || value === undefined || value === '') return;
  target[key] = value;
}

function parseSize(value) {
  if (typeof value !== 'string') return {};
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(value.trim());
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Normalize the useful generation fields from either PNG metadata or a PortOS
 * image sidecar. Unknown sidecar fields are intentionally ignored: catalog
 * metadata is a small, stable provenance projection rather than a copy of an
 * entire provider-specific sidecar or workflow graph.
 */
export function normalizeGenerationMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const metadata = {};

  addIfPresent(metadata, 'format', firstText(input.format));
  addIfPresent(metadata, 'parameters', boundedText(input.parameters));
  addIfPresent(metadata, 'prompt', boundedText(firstText(input.prompt, input.positivePrompt, input.positive_prompt)));
  addIfPresent(metadata, 'negativePrompt', boundedText(firstText(input.negativePrompt, input.negativeprompt, input.negative_prompt, input['negative prompt'], input.negative)));

  const steps = finiteNumber(input.steps ?? input.num_steps);
  if (Number.isInteger(steps) && steps >= 0) metadata.steps = steps;
  addIfPresent(metadata, 'sampler', boundedText(firstText(input.sampler, input.samplerName, input.sampler_name)));

  const cfgScale = finiteNumber(input.cfgScale ?? input.cfg_scale ?? input.guidanceScale ?? input.guidance_scale ?? input.guidance);
  if (cfgScale !== null && cfgScale >= 0) metadata.cfgScale = cfgScale;

  const seed = integerOrString(input.seed);
  if (seed !== null) metadata.seed = seed;

  const size = parseSize(input.size);
  const width = finiteNumber(input.width ?? size.width);
  const height = finiteNumber(input.height ?? size.height);
  if (Number.isInteger(width) && width > 0) metadata.width = width;
  if (Number.isInteger(height) && height > 0) metadata.height = height;

  addIfPresent(metadata, 'modelHash', boundedText(firstText(input.modelHash, input.model_hash)));
  addIfPresent(metadata, 'model', boundedText(firstText(input.model, input.modelName, input.model_name, input.modelId, input.model_id)));

  return metadata;
}

function readNullByte(buffer, start) {
  const index = buffer.indexOf(0, start);
  return index >= start ? index : -1;
}

function inflateText(buffer) {
  try {
    const inflated = inflateSync(buffer, { maxOutputLength: MAX_TEXT_BYTES });
    return boundedText(inflated.toString('utf8'));
  } catch {
    return null;
  }
}

function decodeTextChunk(type, data) {
  const keywordEnd = readNullByte(data, 0);
  if (keywordEnd <= 0 || keywordEnd > 79) return null;
  const keyword = data.toString('latin1', 0, keywordEnd);
  const lowerKeyword = keyword.toLowerCase();

  if (type === 'tEXt') {
    return { keyword, text: boundedText(data.subarray(keywordEnd + 1).toString('utf8')) };
  }

  if (type === 'zTXt') {
    if (keywordEnd + 2 > data.length || data[keywordEnd + 1] !== 0) return null;
    return { keyword, text: inflateText(data.subarray(keywordEnd + 2)) };
  }

  // iTXt: keyword, compression flag, compression method, language tag,
  // translated keyword, then the UTF-8 text. Only method 0 is defined today.
  const header = keywordEnd + 3;
  if (header > data.length || (data[keywordEnd + 1] !== 0 && data[keywordEnd + 1] !== 1) || data[keywordEnd + 2] !== 0) return null;
  const languageEnd = readNullByte(data, header);
  if (languageEnd < 0) return null;
  const translatedEnd = readNullByte(data, languageEnd + 1);
  if (translatedEnd < 0) return null;
  const textData = data.subarray(translatedEnd + 1);
  const text = data[keywordEnd + 1] === 1 ? inflateText(textData) : boundedText(textData.toString('utf8'));
  return { keyword, lowerKeyword, text };
}

function readTextChunks(value) {
  const buffer = asBuffer(value);
  if (!buffer || buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return [];

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  let count = 0;
  while (offset + 12 <= buffer.length && count++ < MAX_PNG_CHUNKS) {
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) break;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    if (TEXT_CHUNK_TYPES.has(type) && length <= MAX_TEXT_CHUNK_BYTES) {
      const decoded = decodeTextChunk(type, buffer.subarray(offset + 8, offset + 8 + length));
      if (decoded?.text) chunks.push(decoded);
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return chunks;
}

function parseJsonObject(text) {
  if (!text || text.length > MAX_TEXT_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const SETTINGS_PATTERN = /(?:^|,\s*)(Steps|Sampler(?: name)?|CFG scale|Guidance scale|Seed|Size|Model hash|Model):\s*/gi;

/** Parse the common Automatic1111 `parameters` text block. */
export function parseStableDiffusionParameters(value) {
  const parameters = boundedText(value);
  if (!parameters) return {};

  const lines = parameters.replace(/\r\n?/g, '\n').split('\n');
  const settingsLine = lines.findIndex((line) => /^\s*Steps:\s*/i.test(line));
  const negativeLine = lines.findIndex((line) => /^\s*Negative prompt:\s*/i.test(line));
  const promptEnd = [settingsLine, negativeLine].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? lines.length;

  const parsed = { format: 'a1111', parameters };
  addIfPresent(parsed, 'prompt', boundedText(lines.slice(0, promptEnd).join('\n')));
  if (negativeLine >= 0 && (settingsLine < 0 || negativeLine < settingsLine)) {
    const end = settingsLine >= 0 ? settingsLine : lines.length;
    addIfPresent(parsed, 'negativePrompt', boundedText(lines.slice(negativeLine, end).join('\n').replace(/^\s*Negative prompt:\s*/i, '')));
  }

  const settings = settingsLine >= 0 ? lines.slice(settingsLine).join(' ') : '';
  const values = {};
  const matches = [...settings.matchAll(SETTINGS_PATTERN)];
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : settings.length;
    values[match[1].toLowerCase()] = settings.slice(start, end).trim().replace(/,+$/, '').trim();
  });
  Object.assign(parsed, {
    steps: values.steps,
    sampler: values.sampler || values['sampler name'],
    cfgScale: values['cfg scale'] || values['guidance scale'],
    seed: values.seed,
    size: values.size,
    modelHash: values['model hash'],
    model: values.model,
  });
  return normalizeGenerationMetadata(parsed);
}

/**
 * Extract a bounded, structured provenance projection from PNG text chunks.
 * Malformed or unsupported metadata is treated as absent so an image upload
 * remains usable; sharp remains the authoritative image-format validator.
 */
export function extractPngGenerationMetadata(value) {
  const result = {};
  for (const chunk of readTextChunks(value)) {
    const key = chunk.keyword.toLowerCase();
    let candidate = {};
    if (key === 'parameters') {
      candidate = parseStableDiffusionParameters(chunk.text);
    } else if (METADATA_KEYS.has(key)) {
      const json = parseJsonObject(chunk.text);
      candidate = json ? normalizeGenerationMetadata(json) : normalizeGenerationMetadata({ [key]: chunk.text });
    }
    for (const [field, fieldValue] of Object.entries(candidate)) {
      if (result[field] === undefined || result[field] === null || result[field] === '') result[field] = fieldValue;
    }
  }
  return result;
}
