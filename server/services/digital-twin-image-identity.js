/**
 * Digital Twin — Image Identity Source (M34 P5)
 *
 * A multi-modal capture slice: the user supplies a photo of themselves and a
 * vision-capable provider extracts the *visible* appearance and self-presentation
 * (apparent age range, build, hair, style, grooming, vibe, setting, expression).
 * The result can be saved as a Digital Twin identity document so the twin has a
 * grounded sense of how the user looks and presents themselves — useful for
 * avatar generation, self-description, and presentation-aware contexts.
 *
 * Reuses the existing vision plumbing (`describeImageDataUrl`) and the prompt
 * stage system; no new capture/transcription infra. The image arrives as a
 * base64 data URL in the request body, is sent to the provider, and is NOT
 * persisted — only the derived text descriptors are.
 */

import { buildPrompt } from './promptService.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { getProviderById } from './providers.js';
import { describeImageDataUrl } from './visionTest.js';
import { loadMeta } from './digital-twin-meta.js';
import { createDocument, updateDocument } from './digital-twin-documents.js';

// The identity document this slice creates/updates on save.
const IDENTITY_DOC = {
  filename: 'APPEARANCE.md',
  title: 'Appearance & Presentation',
  category: 'core'
};

// The vision helper defaults to a short-answer budget (500); the structured
// JSON response here (four prose fields, descriptors, summary, and a woven
// markdown document) needs considerably more headroom.
const VISION_MAX_TOKENS = 1500;

/**
 * Analyze a photo of the user and extract visible appearance / presentation
 * descriptors.
 *
 * @param {object} input
 * @param {string} input.imageDataUrl - base64 image data URL (data:image/...;base64,...)
 * @param {string} input.providerId - a vision-capable API provider
 * @param {string} input.model
 */
export async function analyzeIdentityImage({ imageDataUrl, providerId, model }) {
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return { error: 'A base64 image data URL is required' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }
  // Vision runs over the OpenAI-compatible /chat/completions path, which only
  // the API provider type implements — surface a clear message rather than the
  // raw transport error a CLI/TUI provider would throw.
  if (provider.type !== 'api') {
    return { error: 'Image analysis needs an API provider with a vision-capable model (e.g. a local LM Studio or Ollama vision model)' };
  }

  const prompt = await buildPrompt('twin-image-identity-analyze', {}).catch(() => null);
  if (!prompt) {
    return { error: 'Image identity prompt template not found' };
  }

  // describeImageDataUrl throws on provider/transport errors; translate to the
  // { error } shape the rest of the digital-twin services use. The structured
  // JSON (profiles + woven documentMarkdown) needs more than the vision
  // helper's short-answer default budget, so raise maxTokens or the reply
  // truncates mid-JSON and fails to parse.
  const vision = await describeImageDataUrl({ dataUrl: imageDataUrl, prompt, providerId, model, maxTokens: VISION_MAX_TOKENS })
    .then((text) => ({ text }))
    .catch((err) => ({ error: err?.message || 'Vision request failed' }));

  if (vision.error) {
    return { error: vision.error };
  }
  if (!vision.text) {
    return { error: 'Vision model returned an empty response' };
  }

  return parseIdentityImage(vision.text);
}

/**
 * Persist (or update) the appearance analysis as a Digital Twin identity
 * document. Upserts by filename — mirrors `saveImportAsDocument` so re-running
 * the analysis refreshes the same document instead of erroring on a duplicate.
 *
 * @param {object} suggestedDoc - { content, title? }
 */
export async function saveIdentityImageDocument(suggestedDoc) {
  const content = typeof suggestedDoc?.content === 'string' ? suggestedDoc.content.trim() : '';
  if (!content) {
    return { error: 'No document content to save' };
  }
  const title = (typeof suggestedDoc?.title === 'string' && suggestedDoc.title.trim())
    ? suggestedDoc.title.trim()
    : IDENTITY_DOC.title;

  const meta = await loadMeta();
  const existing = meta.documents.find(d => d.filename === IDENTITY_DOC.filename);
  if (existing) {
    return updateDocument(existing.id, { content, title });
  }
  return createDocument({
    filename: IDENTITY_DOC.filename,
    title,
    category: IDENTITY_DOC.category,
    content,
    enabled: true,
    priority: 5
  });
}

/**
 * Build a markdown identity document from the parsed appearance fields. Used as
 * a fallback when the model omits `documentMarkdown`, so a save always has clean
 * content to persist.
 */
function buildDocumentMarkdown({ summary, appearance, presentation, setting, expression, descriptors }) {
  const lines = ['# Appearance & Presentation', ''];
  if (summary) lines.push(summary, '');
  if (appearance) lines.push('## Appearance', '', appearance, '');
  if (presentation) lines.push('## Presentation', '', presentation, '');
  if (expression) lines.push('## Expression & Demeanor', '', expression, '');
  if (setting) lines.push('## Setting', '', setting, '');
  if (Array.isArray(descriptors) && descriptors.length > 0) {
    lines.push('## Descriptors', '', descriptors.map(d => `- ${d}`).join('\n'), '');
  }
  return lines.join('\n').trim();
}

/**
 * Parse the vision response into a normalized shape. Tolerates a raw JSON
 * object or a ```json fenced block (same convention as the other twin
 * analyzers). Strings default to '' and arrays to [] so the client can
 * distinguish absent from present-but-empty; a `suggestedDocument` is always
 * synthesized so the save action has content even when the model omits
 * `documentMarkdown`.
 */
export function parseIdentityImage(response) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch
    ? jsonMatch[1]
    : (response.trim().startsWith('{') ? response.trim() : null);

  if (!jsonStr) {
    return { error: 'Failed to parse image analysis - no JSON found', rawResponse: response };
  }

  const parsed = safeJSONParse(jsonStr, null, {
    allowArray: false,
    logError: true,
    context: 'image identity analysis'
  });

  if (!parsed) {
    return { error: 'Failed to parse image analysis - invalid JSON', rawResponse: response };
  }

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const fields = {
    appearance: str(parsed.appearance),
    presentation: str(parsed.presentation),
    setting: str(parsed.setting),
    expression: str(parsed.expression),
    descriptors: Array.isArray(parsed.descriptors)
      ? parsed.descriptors.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim()).slice(0, 8)
      : [],
    summary: str(parsed.summary)
  };

  const documentMarkdown = str(parsed.documentMarkdown) || buildDocumentMarkdown(fields);

  return {
    ...fields,
    suggestedDocument: documentMarkdown
      ? { filename: IDENTITY_DOC.filename, title: IDENTITY_DOC.title, category: IDENTITY_DOC.category, content: documentMarkdown }
      : null
  };
}
