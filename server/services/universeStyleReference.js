/**
 * Stateless vision analysis for a universe-bible art-style reference.
 *
 * The service proposes both a reference record and style-guide changes. The
 * client later chooses whether to persist only the reference or atomically
 * persist it together with the proposed guidance.
 */

import { randomUUID } from 'crypto';
import { parseLLMJSON, resolveAPIProvider } from './aiProvider.js';
import { ServerError } from '../lib/errorHandler.js';
import { assertProvider, assertVisionRunUsedImages, runPromptThroughProvider } from '../lib/promptRunner.js';
import { trimTo } from '../lib/storyBible.js';
import {
  sanitizeInfluences,
  sanitizeLocked,
  STYLE_NOTES_MAX,
  STYLE_REFERENCE_PROMPT_MAX,
  STYLE_REFERENCE_TITLE_MAX,
} from './universeBuilder.js';

const listDiff = (before, after) => {
  const beforeKeys = new Set(before.map((value) => value.toLowerCase()));
  const afterKeys = new Set(after.map((value) => value.toLowerCase()));
  return {
    before,
    after,
    added: after.filter((value) => !beforeKeys.has(value.toLowerCase())),
    removed: before.filter((value) => !afterKeys.has(value.toLowerCase())),
    changed: JSON.stringify(before) !== JSON.stringify(after),
  };
};

export function buildStyleReferenceDiff(current, proposed) {
  const beforeInfluences = sanitizeInfluences(current?.influences);
  const afterInfluences = sanitizeInfluences(proposed?.influences);
  const styleNotes = {
    before: trimTo(current?.styleNotes, STYLE_NOTES_MAX),
    after: trimTo(proposed?.styleNotes, STYLE_NOTES_MAX),
  };
  styleNotes.changed = styleNotes.before !== styleNotes.after;
  const embrace = listDiff(beforeInfluences.embrace, afterInfluences.embrace);
  const avoid = listDiff(beforeInfluences.avoid, afterInfluences.avoid);
  return {
    hasChanges: styleNotes.changed || embrace.changed || avoid.changed,
    styleNotes,
    influences: { embrace, avoid },
  };
}

export function buildStyleReferencePrompt({ title, prompt, styleNotes, influences, locked }) {
  const context = JSON.stringify({
    suppliedTitle: trimTo(title, STYLE_REFERENCE_TITLE_MAX) || null,
    suppliedRecreationPrompt: trimTo(prompt, STYLE_REFERENCE_PROMPT_MAX) || null,
    currentStyleNotes: trimTo(styleNotes, STYLE_NOTES_MAX),
    currentGuidance: sanitizeInfluences(influences),
    locked: sanitizeLocked(locked),
  });
  return `Analyze the attached image as an ART STYLE REFERENCE for a fictional-universe bible.

Concentrate on renderable visual style: medium, line or brush treatment, shapes, texture, palette, lighting, composition, era, mood, and finish. Do not invent story facts, named characters, locations, or copyrighted-artist attribution. Produce guidance that could recreate the image's visual language while remaining generally reusable across subjects.

Current universe context:
${context}

Return JSON only:
{
  "title": "short descriptive reference title (generate only when suppliedTitle is null)",
  "prompt": "detailed image-generation prompt for recreating this image (generate only when suppliedRecreationPrompt is null)",
  "styleNotes": "complete proposed replacement for currentStyleNotes",
  "influences": {
    "embrace": ["complete ordered positive style-token list"],
    "avoid": ["complete ordered negative style-token list"]
  },
  "rationale": "one concise explanation of the proposed changes"
}

Honor every locked field: styleNotes, influencesEmbrace, or influencesAvoid must remain equivalent to the corresponding current value when locked. Preserve useful current guidance that does not conflict with the image. An empty array is a valid intentional recommendation.`;
}

export async function analyzeUniverseStyleReference({
  imagePath,
  imageFilename,
  title,
  prompt,
  styleNotes,
  influences,
  locked,
  providerId,
  model,
} = {}) {
  if (!imagePath || !imageFilename) {
    throw new ServerError('A gallery image is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const provider = await resolveAPIProvider(providerId);
  assertProvider(provider, {
    message: 'Analyzing an art reference needs an API-based provider with a vision-capable model. Configure one under Settings → Providers.',
    code: 'NO_API_PROVIDER',
    status: 503,
  });
  const result = await runPromptThroughProvider({
    provider,
    prompt: buildStyleReferencePrompt({ title, prompt, styleNotes, influences, locked }),
    source: 'universe-style-reference',
    model: model || undefined,
    screenshots: [imagePath],
  });
  const ranProvider = assertVisionRunUsedImages(result, provider);
  let parsed;
  try {
    parsed = parseLLMJSON(result.text || '');
  } catch (error) {
    throw new ServerError(`The vision model returned invalid style analysis: ${error.message}`, {
      status: 502,
      code: 'VISION_BAD_JSON',
    });
  }

  const currentInfluences = sanitizeInfluences(influences);
  const safeLocked = sanitizeLocked(locked);
  const generatedTitle = trimTo(title, STYLE_REFERENCE_TITLE_MAX)
    || trimTo(parsed?.title, STYLE_REFERENCE_TITLE_MAX)
    || 'Art style reference';
  const generatedPrompt = trimTo(prompt, STYLE_REFERENCE_PROMPT_MAX)
    || trimTo(parsed?.prompt, STYLE_REFERENCE_PROMPT_MAX);
  if (!generatedPrompt) {
    throw new ServerError('The vision model returned no recreation prompt — try a different model or clearer image.', {
      status: 502,
      code: 'VISION_EMPTY',
    });
  }
  const parsedInfluences = parsed?.influences && typeof parsed.influences === 'object'
    ? parsed.influences
    : {};
  const proposed = {
    styleNotes: safeLocked.styleNotes
      ? trimTo(styleNotes, STYLE_NOTES_MAX)
      : (typeof parsed?.styleNotes === 'string'
        ? trimTo(parsed.styleNotes, STYLE_NOTES_MAX)
        : trimTo(styleNotes, STYLE_NOTES_MAX)),
    influences: {
      embrace: safeLocked.influencesEmbrace
        ? currentInfluences.embrace
        : (Array.isArray(parsedInfluences.embrace)
          ? sanitizeInfluences({ embrace: parsedInfluences.embrace }).embrace
          : currentInfluences.embrace),
      avoid: safeLocked.influencesAvoid
        ? currentInfluences.avoid
        : (Array.isArray(parsedInfluences.avoid)
          ? sanitizeInfluences({ avoid: parsedInfluences.avoid }).avoid
          : currentInfluences.avoid),
    },
  };

  return {
    reference: {
      id: `style-ref-${randomUUID()}`,
      title: generatedTitle,
      prompt: generatedPrompt,
      imageRefs: [imageFilename],
      createdAt: new Date().toISOString(),
    },
    proposed,
    diff: buildStyleReferenceDiff({ styleNotes, influences: currentInfluences }, proposed),
    rationale: trimTo(parsed?.rationale, 1000),
    llm: {
      provider: ranProvider.id || provider.id,
      model: result.model || null,
    },
  };
}

export const __testing = { buildStyleReferencePrompt, buildStyleReferenceDiff };
