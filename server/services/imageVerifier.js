/**
 * imageVerifier.js — Verification engine, profile store, and sidecar integration
 * for image quality assurance and defect detection in PortOS.
 */

import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { ServerError } from '../lib/errorHandler.js';
import { resolveGalleryImage, assertGalleryFilename } from '../lib/pathSafety.js';
import { getSettings, saveSettings } from './settings.js';
import { editImageSidecar } from './imageGen/sidecarStore.js';
import { isOllamaBackedProvider } from '../lib/aiToolkit/internal/ollamaBacked.js';
import {
  DEFAULT_VERIFICATION_PROFILES,
  verificationProfileSchema,
  buildMultiAspectVerificationPrompt,
  buildDefectConfirmationPrompt,
  parseVerificationResponse,
  parseConfirmationResponse,
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
 * Updates Image Verifier settings.
 */
export async function updateVerifierSettings(updates) {
  const current = await getSettings();
  const existing = current.imageVerification || {};
  const merged = { ...existing, ...updates };
  await saveSettings({ ...current, imageVerification: merged });
  return getVerifierSettings();
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
 * Creates or updates a custom verification profile.
 */
export async function saveCustomProfile(profileData) {
  const validated = verificationProfileSchema.parse(profileData);
  const settings = await getVerifierSettings();
  const existingProfiles = settings.customProfiles.filter((p) => p.id !== validated.id);
  existingProfiles.push(validated);
  await updateVerifierSettings({ customProfiles: existingProfiles });
  return validated;
}

/**
 * Deletes a custom verification profile.
 */
export async function deleteCustomProfile(id) {
  if (DEFAULT_VERIFICATION_PROFILES[id]) {
    throw new ServerError(`Cannot delete built-in profile "${id}"`, { status: 400, code: 'CANNOT_DELETE_BUILTIN' });
  }
  const settings = await getVerifierSettings();
  const filtered = settings.customProfiles.filter((p) => p.id !== id);
  await updateVerifierSettings({ customProfiles: filtered });
  return { deleted: true, id };
}

/**
 * Resolves the vision reviewer to use for inspection.
 */
export async function resolveVisionReviewer(reviewer = null) {
  const { resolvePlateReviewer } = await import('./musicVideo/plateReview.js');
  return resolvePlateReviewer(reviewer || {});
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
  prompt = '',
  reviewer: reviewerInput,
  isImport = false,
  source = 'image-verifier',
  beforeExecute,
}) {
  const settings = await getVerifierSettings();
  const profile = profileInput
    ? verificationProfileSchema.parse(profileInput)
    : await getVerificationProfile(profileId || settings.defaultProfileId);

  const resolvedPath = imagePath || (filename ? resolveGalleryImage(filename) : null);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    throw new ServerError(`Image file not found: ${filename || imagePath}`, { status: 404, code: 'IMAGE_NOT_FOUND' });
  }

  const reviewer = await resolveVisionReviewer(reviewerInput || profile.reviewer || settings.reviewer);
  const { runPromptThroughProvider, assertVisionRunUsedImages } = await import('./promptRunner.js');

  // Pass 1: Multi-Aspect Scan
  const pass1Prompt = buildMultiAspectVerificationPrompt({ profile, prompt, isImport });
  const result1 = await runPromptThroughProvider({
    provider: { ...reviewer.provider, thinking: false },
    model: reviewer.model,
    prompt: pass1Prompt,
    screenshots: [resolvedPath],
    source,
    timeout: Math.min(reviewer.provider.timeout || 120000, 120000),
    toolFree: true,
    allowFallback: false,
    beforeExecute,
  });
  assertVisionRunUsedImages(result1, reviewer.provider);

  const parsed = parseVerificationResponse(result1.text);
  const advisory = isAdvisoryVisionReviewer(reviewer.provider);

  // Pass 2: Skeptical Defect Confirmation
  if (parsed.defects.length > 0) {
    const confirmedDefects = [];
    for (const defect of parsed.defects) {
      try {
        const pass2Prompt = buildDefectConfirmationPrompt({
          claim: defect.claim,
          dimension: defect.dimension,
          region: defect.region,
          prompt,
        });

        const result2 = await runPromptThroughProvider({
          provider: { ...reviewer.provider, thinking: false },
          model: reviewer.model,
          prompt: pass2Prompt,
          screenshots: [resolvedPath],
          source: `${source}-confirmation`,
          timeout: Math.min(reviewer.provider.timeout || 120000, 120000),
          toolFree: true,
          allowFallback: false,
          beforeExecute,
        });
        assertVisionRunUsedImages(result2, reviewer.provider);

        const confirmation = parseConfirmationResponse(result2.text);
        if (confirmation.confirmed) {
          confirmedDefects.push({
            ...defect,
            confirmed: true,
            confirmationNote: confirmation.note,
            region: confirmation.region || defect.region,
          });
        } else {
          // False alarm: Demote corresponding check to unverified
          parsed.checks = parsed.checks.map((c) => (c.dimension === defect.dimension
            ? { ...c, status: 'unverified', note: `Unconfirmed defect claim: ${c.note || defect.claim}` }
            : c));
        }
      } catch (err) {
        if (!advisory) confirmedDefects.push(defect);
      }
    }

    parsed.defects = confirmedDefects;
    const hasRemainingCritical = parsed.checks.some((c) => c.status === 'fail' && c.severity === 'critical')
      || confirmedDefects.some((d) => d.severity === 'critical');
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
  if (filename) {
    await editImageSidecar(filename, (meta) => {
      meta.verification = verificationRecord;
      return meta;
    }).catch((err) => console.error(`⚠️ Failed to update image sidecar verification for ${filename}:`, err.message));
  }

  imageVerifierEvents.emit('verified', { filename, verification: verificationRecord });
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
