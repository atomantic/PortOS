/**
 * Orchestration Profiles Service (issue #5992).
 *
 * Manages the machine-local named-profile library for CoS orchestration.
 * A named profile configures provider, model, and reasoning effort across
 * the three roles (architect, implementer, reviewer) once, so tasks can
 * reference or inherit them instead of re-specifying all roles per task.
 *
 * Persisted in data/settings.json (file-primary, machine-local, non-federated)
 * with built-in starters merged in.
 */

import { getSettings, updateSettingsWith } from './settings.js';
import { BUILT_IN_ORCHESTRATION_PROFILES } from '../lib/orchestrationProfile.js';
import { namedOrchestrationProfileSchema } from '../lib/validation.js';
import { ServerError } from '../lib/errorHandler.js';

const BUILT_IN_IDS = new Set(BUILT_IN_ORCHESTRATION_PROFILES.map((p) => p.id));

/**
 * List all available orchestration profiles, merging built-in starters with
 * user-defined profiles stored in settings.json.
 *
 * @returns {Promise<Array<{id: string, name: string, description?: string, profile: object, isBuiltin?: boolean}>>}
 */
export async function getOrchestrationProfiles() {
  const settings = await getSettings();
  const userProfiles = Array.isArray(settings.orchestrationProfiles)
    ? settings.orchestrationProfiles
    : [];

  const userProfileIds = new Set(userProfiles.map((p) => p.id));
  const activeBuiltIns = BUILT_IN_ORCHESTRATION_PROFILES.filter((p) => !userProfileIds.has(p.id));

  return [...activeBuiltIns, ...userProfiles];
}

/**
 * Find one orchestration profile by ID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getOrchestrationProfileById(id) {
  if (!id || typeof id !== 'string') return null;
  const profiles = await getOrchestrationProfiles();
  return profiles.find((p) => p.id === id) ?? null;
}

/**
 * Save (create or overwrite) a named orchestration profile.
 *
 * @param {object} raw
 * @returns {Promise<object>} The saved profile
 */
export async function saveOrchestrationProfile(raw) {
  const parsed = namedOrchestrationProfileSchema.parse(raw);
  const profileToSave = {
    ...parsed,
    isBuiltin: false,
  };

  await updateSettingsWith(async (current) => {
    const existing = Array.isArray(current.orchestrationProfiles)
      ? [...current.orchestrationProfiles]
      : [];

    const index = existing.findIndex((p) => p.id === profileToSave.id);
    if (index >= 0) {
      existing[index] = profileToSave;
    } else {
      existing.push(profileToSave);
    }

    return { ...current, orchestrationProfiles: existing };
  });

  return profileToSave;
}

/**
 * Partially update an existing orchestration profile.
 *
 * @param {string} id
 * @param {object} updates
 * @returns {Promise<object>} The updated profile
 */
export async function updateOrchestrationProfile(id, updates) {
  if (!id || typeof id !== 'string') {
    throw new ServerError('Profile ID is required', { status: 400 });
  }

  const existing = await getOrchestrationProfileById(id);
  if (!existing) {
    throw new ServerError(`Orchestration profile "${id}" not found`, { status: 404 });
  }

  const merged = {
    ...existing,
    ...updates,
    id, // protect ID from being altered
    profile: {
      ...existing.profile,
      ...(updates.profile || {}),
    },
  };

  return saveOrchestrationProfile(merged);
}

/**
 * Delete a user-defined orchestration profile. Built-in profiles without user
 * overrides cannot be deleted.
 *
 * @param {string} id
 * @returns {Promise<{success: boolean, deleted: string}>}
 */
export async function deleteOrchestrationProfile(id) {
  if (!id || typeof id !== 'string') {
    throw new ServerError('Profile ID is required', { status: 400 });
  }

  const settings = await getSettings();
  const userProfiles = Array.isArray(settings.orchestrationProfiles)
    ? settings.orchestrationProfiles
    : [];

  const existsInUser = userProfiles.some((p) => p.id === id);

  if (!existsInUser && BUILT_IN_IDS.has(id)) {
    throw new ServerError('Cannot delete built-in orchestration profile', { status: 400 });
  }

  if (!existsInUser) {
    throw new ServerError(`Orchestration profile "${id}" not found`, { status: 404 });
  }

  await updateSettingsWith(async (current) => {
    const existing = Array.isArray(current.orchestrationProfiles)
      ? current.orchestrationProfiles
      : [];
    const filtered = existing.filter((p) => p.id !== id);
    return { ...current, orchestrationProfiles: filtered };
  });

  return { success: true, deleted: id };
}
