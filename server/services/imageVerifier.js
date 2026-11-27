/**
 * imageVerifier.js — Verification engine, profile store, and sidecar integration
 * for image quality assurance and defect detection in PortOS.
 */

import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { basename } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { resolveGalleryImage } from '../lib/pathSafety.js';
import { assertGalleryFilename } from './imageGen/local.js';
import { getSettings } from './settings.js';
import { editImageSidecar, readImageSidecar } from './imageGen/sidecarStore.js';
import { runCancellablePrompt } from './cancellablePrompt.js';
import { isOllamaBackedProvider } from '../lib/aiToolkit/internal/ollamaBacked.js';
import {
  DEFAULT_VERIFICATION_PROFILES,
  verificationProfileSchema,
  buildMultiAspectVerificationPrompt,
  buildBatchDefectConfirmationPrompt,
  parseVerificationResponse,
  parseBatchConfirmationResponse,
} from '../lib/imageVerification.js';

export const isAdvisoryVisionReviewer = isOllamaBackedProvider;
export const imageVerifierEvents = new EventEmitter();

/**
 * Returns the current Image Verifier settings.
 */
export async function getVerifierSettings() {
  const settings = await getSettings();
  const iv = settings.imageVerification || {};
  return {
    enabledForGeneration: Boolean(iv.enabledForGeneration),
    enabledForImport: Boolean(iv.enabledForImport),
    defaultProfileId: iv.defaultProfileId || 'strict_anatomy',
    maxRerolls: Number.isFinite(iv.maxRerolls) ? Math.max(0, Math.min(5, iv.maxRerolls)) : 2,
    reviewer: iv.reviewer || null,
    customProfiles: Array.isArray(iv.customProfiles) ? iv.customProfiles : [],
  };
}

/**
 * Lists all available verification profiles (built-in + user custom).
 */
export async function getVerificationProfiles() {
  const settings = await getVerifierSettings();
  const profiles = { ...DEFAULT_VERIFICATION_PROFILES };
  for (const custom of settings.customProfiles) {
    if (custom?.id) {
      profiles[custom.id] = custom;
    }
  }
  return profiles;
}

/**
 * Gets a single verification profile by id.
 */
export async function getVerificationProfile(id) {
  const profiles = await getVerificationProfiles();
  return profiles[id] || DEFAULT_VERIFICATION_PROFILES[id] || DEFAULT_VERIFICATION_PROFILES.strict_anatomy;
}

/**
 * Resolves the vision reviewer to use for inspection.
 */
async function resolveVisionReviewer(reviewerInput = null) {
  const { resolvePlateReviewer } = await import('./musicVideo/plateReview.js');
  const { getAllProviders } = await import('./provider/providers.js');

  const reviewer = typeof reviewerInput === 'string'
    ? { model: reviewerInput }
    : { ...(reviewerInput || {}) };

  if (reviewer.model === 'auto') {
    delete reviewer.model;
  }

  // If a specific model is requested without an explicit providerId, find the best provider that hosts it
  if (reviewer.model && !reviewer.providerId) {
    const modelLower = reviewer.model.toLowerCase();
    const { providers = [] } = await getAllProviders().catch(() => ({ providers: [] }));

    // Argon models: find Google / Antigravity / Gemini provider with Argon
    if (/argon/i.test(modelLower)) {
      const argonProvider = providers.find((p) =>
        p.enabled !== false &&
        (Array.isArray(p.models) && p.models.some((m) => /argon/i.test(m)))
      ) || providers.find((p) =>
        p.enabled !== false && /antigravity|gemini|google/i.test(p.id || p.name || '')
      );
      if (argonProvider) {
        reviewer.providerId = argonProvider.id;
        if (Array.isArray(argonProvider.models)) {
          const exact = argonProvider.models.find((m) => /argon/i.test(m));
          if (exact) reviewer.model = exact;
        } else if (reviewer.model === 'argon') {
          reviewer.model = 'gemini-4-argon-medium';
        }
      }
    }
    // Qwen 27B / 27G models: find Ollama / vLLM / LM Studio provider with Qwen 27b/g
    else if (/qwen/i.test(modelLower)) {
      const qwenProvider = providers.find((p) =>
        p.enabled !== false &&
        (Array.isArray(p.models) && p.models.some((m) => /qwen.*(?:27[bg]|3\.8)/i.test(m)))
      ) || providers.find((p) =>
        p.enabled !== false && (p.type === 'ollama' || /ollama|vllm|lmstudio/i.test(p.id || p.name || ''))
      );
      if (qwenProvider) {
        reviewer.providerId = qwenProvider.id;
        if (Array.isArray(qwenProvider.models)) {
          const exact = qwenProvider.models.find((m) => /qwen.*(?:27[bg]|3\.8)/i.test(m));
          if (exact) reviewer.model = exact;
        } else if (reviewer.model === 'qwen' || /qwen-?27[bg]/i.test(reviewer.model)) {
          reviewer.model = 'qwen3.8:27b';
        }
      }
    }
    // Claude / Sonnet models
    else if (/claude|sonnet/i.test(modelLower)) {
      const claudeProvider = providers.find((p) =>
        p.enabled !== false &&
        (Array.isArray(p.models) && p.models.some((m) => /sonnet/i.test(m)))
      ) || providers.find((p) =>
        p.enabled !== false && /claude|anthropic/i.test(p.id || p.name || '')
      );
      if (claudeProvider) {
        reviewer.providerId = claudeProvider.id;
      }
    }
  }

  // If a provider was resolved (or explicitly provided)
  if (reviewer.providerId) {
    const { getProviderById } = await import('./provider/providers.js');
    const { resolveEffectiveModel } = await import('./promptRunner.js');
    let provider = await getProviderById(reviewer.providerId).catch(() => null);
    if (!provider) {
      const { providers = [] } = await getAllProviders().catch(() => ({ providers: [] }));
      provider = providers.find((p) => p.id === reviewer.providerId);
    }
    if (provider && provider.enabled !== false) {
      const selectedModel = resolveEffectiveModel(provider, reviewer.model);
      return { provider, model: selectedModel, costUsd: 0 };
    }
  }

  // Fall back to plate reviewer if available
  try {
    return await resolvePlateReviewer(reviewer);
  } catch (plateErr) {
    // If plate reviewer fails, find any enabled vision-capable or multimodal provider
    const { providers = [] } = await getAllProviders().catch(() => ({ providers: [] }));
    const candidate = providers.find((p) =>
      p.enabled !== false &&
      (
        /antigravity|gemini|google|claude|codex|grok|ollama/i.test(p.id || p.command || '') ||
        (Array.isArray(p.models) && p.models.some((m) => /argon|vision|llava|qwen|sonnet/i.test(m)))
      )
    );
    if (candidate) {
      const { resolveEffectiveModel } = await import('./promptRunner.js');
      const selectedModel = resolveEffectiveModel(candidate, reviewer.model);
      return { provider: candidate, model: selectedModel, costUsd: 0 };
    }
    throw plateErr;
  }
}

/**
 * Core image verification function.
 * Evaluates an image file (generated or imported) against a verification profile.
 */
export async function verifyImage({
  filename,
  imagePath,
  profile: profileInput,
  profileId,
  prompt,
  reviewer: reviewerInput,
  isImport = false,
  source = 'image-verifier',
  beforeExecute,
  signal,
}) {
  signal?.throwIfAborted();
  const settings = await getVerifierSettings();
  const profile = profileInput
    ? verificationProfileSchema.parse(profileInput)
    : await getVerificationProfile(profileId || settings.defaultProfileId);

  // Use the same gallery basename for the image and both sidecar spellings.
  const galleryFilename = filename ? basename(filename) : null;
  const resolvedPath = imagePath || (galleryFilename ? resolveGalleryImage(galleryFilename) : null);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    throw new ServerError(`Image file not found: ${filename || imagePath}`, { status: 404, code: 'IMAGE_NOT_FOUND' });
  }

  let generationPrompt = prompt;
  if (generationPrompt === undefined && galleryFilename) {
    const { metadata } = await readImageSidecar(galleryFilename);
    if (typeof metadata?.prompt === 'string') generationPrompt = metadata.prompt;
  }
  const reviewer = await resolveVisionReviewer(reviewerInput || profile.reviewer || settings.reviewer);
  const { runPromptThroughProvider, assertVisionRunUsedImages } = await import('./promptRunner.js');
  const { isToolFreeOneShotProvider } = await import('../lib/provider/providerVendors.js');

  const runVision = async (reviewPrompt, reviewSource) => {
    const result = await runCancellablePrompt(runPromptThroughProvider, {
      provider: { ...reviewer.provider, thinking: false },
      model: reviewer.model,
      prompt: reviewPrompt,
      screenshots: [resolvedPath],
      source: reviewSource,
      timeout: Math.min(reviewer.provider.timeout || 120000, 120000),
      toolFree: isToolFreeOneShotProvider(reviewer.provider),
      allowFallback: false,
      beforeExecute,
    }, signal);
    assertVisionRunUsedImages(result, reviewer.provider);
    return result;
  };

  // Pass 1: Multi-Aspect Scan
  const pass1Prompt = buildMultiAspectVerificationPrompt({ profile, prompt: generationPrompt, isImport });
  const result1 = await runVision(pass1Prompt, source);
  const parsed = parseVerificationResponse(result1.text);

  // Pass 2: Skeptical Defect Confirmation
  if (parsed.defects.length > 0) {
    const pass2Prompt = buildBatchDefectConfirmationPrompt({ defects: parsed.defects, prompt: generationPrompt });
    const result2 = await runVision(pass2Prompt, `${source}-confirmation`).catch(() => null);
    signal?.throwIfAborted();

    if (result2) {
      const { verdicts } = parseBatchConfirmationResponse(result2.text, parsed.defects.length);
      const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
      const claims = parsed.defects;

      // The first pass emits failed checks as claims in order, then appends any hand-only claim.
      let claimIndex = 0;
      parsed.checks = parsed.checks.map((check) => {
        if (check.status !== 'fail') return check;
        const index = claimIndex++;
        if (byIndex.get(index)?.confirmed) return check;
        return { ...check, status: 'unverified', note: `Unconfirmed defect claim: ${check.note || claims[index].claim}` };
      });
      parsed.defects = claims.flatMap((defect, index) => {
        const verdict = byIndex.get(index);
        return verdict?.confirmed ? [{
          ...defect,
          confirmationNote: verdict.note,
          region: verdict.region || defect.region,
        }] : [];
      });
    } else if (isAdvisoryVisionReviewer(reviewer.provider)) {
      // Keep first-pass checks but drop advisory defects when the confirmation run fails.
      parsed.defects = [];
    }

    const hasRemainingCritical = parsed.checks.some((c) => c.status === 'fail' && c.severity === 'critical')
      || parsed.defects.some((d) => d.severity === 'critical');
    parsed.overallVerdict = hasRemainingCritical ? 'fail' : 'pass';
  }

  const verificationRecord = {
    verdict: parsed.overallVerdict,
    verifiedAt: new Date().toISOString(),
    profileId: profile.id,
    profileName: profile.name,
    summary: parsed.summary,
    defects: parsed.defects,
    hands: parsed.hands,
    checks: parsed.checks,
    reviewer: {
      providerId: reviewer.provider.id,
      model: result1.model || reviewer.model,
    },
  };

  // Persist to sidecar if filename is provided
  if (galleryFilename) {
    await editImageSidecar(galleryFilename, (meta) => {
      if (signal?.aborted) return null;
      meta.verification = verificationRecord;
      return meta;
    }).catch((err) => console.error(`⚠️ Failed to update image sidecar verification for ${filename}:`, err.message));
  }

  signal?.throwIfAborted();
  imageVerifierEvents.emit('verified', { filename: galleryFilename || filename, verification: verificationRecord });
  return verificationRecord;
}

/**
 * Async fire-and-forget verifier for imports and background tasks.
 */
export function verifyImageAsync(filename, options = {}) {
  setImmediate(async () => {
    try {
      await verifyImage({ filename, isImport: true, ...options });
    } catch (err) {
      console.warn(`🔍 Async verification failed for ${filename}: ${err.message}`);
    }
  });
}

/**
 * Manual operator override for false positives or force-pass actions.
 */
export async function overrideVerification({ filename, verdict, notes = '', operator = 'operator' }) {
  assertGalleryFilename(filename);
  let updated = null;
  await editImageSidecar(filename, (meta) => {
    const previous = meta.verification || {};
    updated = {
      ...previous,
      verdict,
      overridden: true,
      overriddenAt: new Date().toISOString(),
      operator,
      overrideNotes: notes,
    };
    meta.verification = updated;
    return meta;
  });

  imageVerifierEvents.emit('verified', { filename, verification: updated });
  return updated;
}
