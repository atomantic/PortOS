// Media-generation voice tool (image_generate): text-to-image into the user's
// gallery, defaulting to their saved Image Gen backend. Local/codex backends
// return a job descriptor and emit completion later, so this subscribes via the
// imageGen waiter before kicking off the job.

import * as imageGen from '../../imageGen/index.js';
import { createImageGenWaiter } from '../../imageGenWaiter.js';
import { getSettings } from '../../settings.js';

// Imagery verbs that should surface image_generate. Tight-ish: avoids
// common false positives like "imagine if" or "show me a picture of the
// page" by anchoring on creation verbs paired with visual nouns.
export const MEDIA_INTENT_RE = /\b(?:generate|render|create|draw|sketch|paint|illustrate|make|design|produce)\b[^.!?\n]{0,30}\b(?:image|picture|photo|illustration|art(?:work)?|render|drawing|sketch|portrait|wallpaper|scene|asset|graphic|logo|icon)\b|\bimagegen\b/i;

export const MEDIA_TOOLS = [
  {
    name: 'image_generate',
    description:
      'Generate an image from a text prompt and save it to the user\'s gallery. Defaults to the user\'s saved Image Gen backend (Local mflux, External SD API, or Codex CLI). Pass `provider` to override per-call: "local" for fast Flux drafts, "external" for an A1111-compatible server, "codex" for the Codex CLI built-in image_gen tool, or "grok" for the Grok Build CLI built-in image_gen tool (both subject to the user enabling them in Settings). Returns the saved file path.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to draw, in natural language. Be specific about subject, style, and mood.',
        },
        provider: {
          type: 'string',
          enum: ['auto', ...imageGen.IMAGE_GEN_MODES],
          description: '"auto" (default) uses the user\'s saved backend. Override only when the user explicitly asks for a specific one or the task strongly favors it.',
        },
        negativePrompt: {
          type: 'string',
          description: 'Optional list of things to avoid (e.g. "watermark, low quality").',
        },
        width: { type: 'integer', description: 'Optional pixel width (64-2048).' },
        height: { type: 'integer', description: 'Optional pixel height (64-2048).' },
      },
      required: ['prompt'],
    },
    execute: async ({ prompt, provider, negativePrompt, width, height } = {}) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, summary: 'prompt is required' };
      }
      // Match the /api/image-gen/generate Zod schema (max 2000 chars).
      // Voice tool calls bypass the route entirely, so without this an
      // oversized prompt would propagate to providers and fail with a
      // less helpful error (codex CLI in particular hits OS ARG_MAX
      // limits before the model even sees the prompt).
      if (prompt.length > 2000) {
        return { ok: false, summary: 'prompt must be 2000 characters or fewer' };
      }
      const requestedMode = (provider && provider !== 'auto') ? provider : undefined;
      // Cloud-CLI providers (codex/grok) are gated separately — each costs
      // against the user's plan, and not every plan exposes the image tool.
      // The dispatcher would also reject this, but catching it here lets us
      // return a friendlier summary to the voice agent / palette. The
      // settings key equals the mode string for both.
      if (imageGen.CLOUD_IMAGE_GEN_MODES.includes(requestedMode)) {
        const s = await getSettings();
        if (!s?.imageGen?.[requestedMode]?.enabled) {
          const label = requestedMode === imageGen.IMAGE_GEN_MODE.CODEX ? 'Codex' : 'Grok';
          return { ok: false, summary: `${label} Imagegen is disabled — enable it in Settings → Image Gen first.` };
        }
      }
      // LLMs/tool callers often hand back numeric args as strings ("512").
      // Coerce + bounds-check before forwarding — the route's Zod schema
      // also gates these, but voice tool calls bypass the route, so an
      // unvalidated string would propagate to providers that build
      // payloads with raw width values (external SD API: "width": "512").
      const normalizeDimension = (value, name) => {
        if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 64 || parsed > 2048) {
          return { ok: false, summary: `${name} must be an integer between 64 and 2048` };
        }
        return { ok: true, value: parsed };
      };
      const w = normalizeDimension(width, 'width');
      if (!w.ok) return w;
      const h = normalizeDimension(height, 'height');
      if (!h.ok) return h;
      // Local + codex backends return a job descriptor synchronously and
      // emit 'completed'/'failed' on imageGenEvents when the file actually
      // lands. Subscribe BEFORE calling generateImage so a fast job can't
      // emit 'completed' before we attach. External backends await the
      // upstream HTTP call internally and the file is on disk by the time
      // generateImage resolves — wait() is a no-op there.
      // 21-min cap sits just past the cloud providers' own 20-minute
      // wall-clock timeouts (CODEX_TIMEOUT_MS / GROK_TIMEOUT_MS) so a slow
      // but valid render isn't reported as a timeout while the job keeps
      // running; a stuck job still can't leak listeners forever.
      const waiter = createImageGenWaiter({ timeoutMs: 21 * 60 * 1000 });

      let result;
      try {
        result = await imageGen.generateImage({
          prompt: prompt.trim(),
          negativePrompt: negativePrompt?.trim() || undefined,
          width: w.value,
          height: h.value,
          mode: requestedMode,
        });
      } catch (err) {
        waiter.cleanup();
        return { ok: false, summary: `Image generation failed: ${err?.message || err}` };
      }

      const usedMode = result?.mode || requestedMode || 'default';
      const isAsync = usedMode === imageGen.IMAGE_GEN_MODE.LOCAL || imageGen.CLOUD_IMAGE_GEN_MODES.includes(usedMode);
      // External resolves with the file already on disk — short-circuit.
      if (!isAsync) {
        waiter.cleanup();
        return {
          ok: true,
          path: result?.path,
          filename: result?.filename,
          mode: usedMode,
          summary: `Generated image (${usedMode}): ${result?.filename || 'pending'}`,
        };
      }

      waiter.register(result.generationId);
      const ev = await waiter.promise.catch((errEv) => ({ __failed: true, ...errEv }));
      if (ev?.__failed) {
        return { ok: false, summary: `Image generation failed: ${ev.error || 'unknown'}` };
      }
      // The 'completed' event carries the canonical path/filename — prefer
      // it over the descriptor returned by generateImage (which may not
      // have the final filename in some providers).
      return {
        ok: true,
        path: ev?.path || result?.path,
        filename: ev?.filename || result?.filename,
        mode: usedMode,
        summary: `Generated image (${usedMode}): ${ev?.filename || result?.filename}`,
      };
    },
  },
];
