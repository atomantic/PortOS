/**
 * App Activity Tracking Service
 *
 * Manages per-app cooldowns, review history, and active work tracking.
 * Prevents the CoS from working on the same app in a loop.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.cos;
const ACTIVITY_FILE = join(DATA_DIR, 'app-activity.json');

const DEFAULT_ACTIVITY = {
  apps: {},
  global: {
    lastIdleReviewAt: null,
    totalReviews: 0
  }
};

/**
 * Ensure the data directory exists
 */
async function ensureDataDir() {
  await ensureDir(DATA_DIR);
}

/**
 * Load app activity data
 */
export async function loadAppActivity() {
  await ensureDataDir();

  const loaded = await readJSONFile(ACTIVITY_FILE, null);
  return loaded ? { ...DEFAULT_ACTIVITY, ...loaded } : { ...DEFAULT_ACTIVITY };
}

/**
 * Save app activity data
 */
export async function saveAppActivity(activity) {
  await ensureDataDir();
  await writeFile(ACTIVITY_FILE, JSON.stringify(activity, null, 2));
}

/**
 * Get activity for a specific app
 */
export async function getAppActivityById(appId) {
  const activity = await loadAppActivity();
  return activity.apps[appId] || null;
}

/**
 * Update activity for a specific app
 */
export async function updateAppActivity(appId, updates) {
  const activity = await loadAppActivity();

  if (!activity.apps[appId]) {
    activity.apps[appId] = {
      lastReviewedAt: null,
      lastTaskCompletedAt: null,
      activeAgentId: null,
      cooldownUntil: null,
      lastImprovementType: null,  // Track last self-improvement analysis type
      stats: {
        reviewCount: 0,
        issuesFound: 0,
        issuesFixed: 0
      }
    };
  }

  // Merge updates, handling nested stats object
  if (updates.stats) {
    activity.apps[appId].stats = { ...activity.apps[appId].stats, ...updates.stats };
    delete updates.stats;
  }

  activity.apps[appId] = { ...activity.apps[appId], ...updates };
  await saveAppActivity(activity);

  return activity.apps[appId];
}

/**
 * Start cooldown for an app (called when agent completes work on it)
 */
export async function startAppCooldown(appId, cooldownMs) {
  const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  return updateAppActivity(appId, {
    cooldownUntil,
    activeAgentId: null,
    lastTaskCompletedAt: new Date().toISOString()
  });
}

/**
 * Mark an app review as started
 */
export async function markAppReviewStarted(appId, agentId) {
  return updateAppActivity(appId, {
    activeAgentId: agentId,
    lastReviewedAt: new Date().toISOString()
  });
}

/**
 * Mark an app review as completed
 */
export async function markAppReviewCompleted(appId, issuesFound = 0, issuesFixed = 0) {
  const activity = await getAppActivityById(appId) || { stats: {} };
  return updateAppActivity(appId, {
    activeAgentId: null,
    stats: {
      reviewCount: (activity.stats?.reviewCount || 0) + 1,
      issuesFound: (activity.stats?.issuesFound || 0) + issuesFound,
      issuesFixed: (activity.stats?.issuesFixed || 0) + issuesFixed
    }
  });
}

/**
 * Clear cooldown for an app (manual override)
 */
export async function clearAppCooldown(appId) {
  return updateAppActivity(appId, { cooldownUntil: null });
}

/**
 * Check if an app is on cooldown
 */
export async function isAppOnCooldown(appId, cooldownMs) {
  const activity = await loadAppActivity();
  const appActivity = activity.apps[appId];

  if (!appActivity) return false;

  const now = Date.now();

  // Check explicit cooldown
  if (appActivity.cooldownUntil) {
    const cooldownTime = new Date(appActivity.cooldownUntil).getTime();
    if (cooldownTime > now) {
      return true;
    }
  }

  // Check last activity time against cooldown period
  const lastActivity = Math.max(
    appActivity.lastReviewedAt ? new Date(appActivity.lastReviewedAt).getTime() : 0,
    appActivity.lastTaskCompletedAt ? new Date(appActivity.lastTaskCompletedAt).getTime() : 0
  );

  if (lastActivity && (now - lastActivity) < cooldownMs) {
    return true;
  }

  // Check if already has an active agent
  if (appActivity.activeAgentId) {
    return true;
  }

  return false;
}

/**
 * Get the next app eligible for review (not on cooldown, oldest review first)
 */
export async function getNextAppForReview(apps, cooldownMs) {
  const activity = await loadAppActivity();
  const now = Date.now();

  // Build list of eligible apps with their last review time
  const eligible = [];

  for (const app of apps) {
    const appActivity = activity.apps[app.id];

    // Skip if on cooldown
    if (appActivity) {
      // Check explicit cooldown
      if (appActivity.cooldownUntil && new Date(appActivity.cooldownUntil).getTime() > now) {
        continue;
      }

      // Check last activity cooldown
      const lastActivity = Math.max(
        appActivity.lastReviewedAt ? new Date(appActivity.lastReviewedAt).getTime() : 0,
        appActivity.lastTaskCompletedAt ? new Date(appActivity.lastTaskCompletedAt).getTime() : 0
      );

      if (lastActivity && (now - lastActivity) < cooldownMs) {
        continue;
      }

      // Check active agent
      if (appActivity.activeAgentId) {
        continue;
      }
    }

    // App is eligible
    const lastReview = appActivity?.lastReviewedAt
      ? new Date(appActivity.lastReviewedAt).getTime()
      : 0;

    eligible.push({
      app,
      lastReview,
      timeSinceReview: now - lastReview
    });
  }

  // Sort by longest time since review (oldest first)
  eligible.sort((a, b) => b.timeSinceReview - a.timeSinceReview);

  return eligible[0]?.app || null;
}

/**
 * Update global idle review timestamp
 */
export async function markIdleReviewStarted() {
  const activity = await loadAppActivity();
  activity.global.lastIdleReviewAt = new Date().toISOString();
  activity.global.totalReviews = (activity.global.totalReviews || 0) + 1;
  await saveAppActivity(activity);
  return activity.global;
}

/**
 * Get time until next eligible app is off cooldown
 */
export async function getNextCooldownExpiry(apps, cooldownMs) {
  const activity = await loadAppActivity();
  const now = Date.now();
  let nextExpiry = null;

  for (const app of apps) {
    const appActivity = activity.apps[app.id];
    if (!appActivity) continue;

    // Check explicit cooldown
    if (appActivity.cooldownUntil) {
      const expiryTime = new Date(appActivity.cooldownUntil).getTime();
      if (expiryTime > now && (!nextExpiry || expiryTime < nextExpiry)) {
        nextExpiry = expiryTime;
      }
    }

    // Check activity-based cooldown
    const lastActivity = Math.max(
      appActivity.lastReviewedAt ? new Date(appActivity.lastReviewedAt).getTime() : 0,
      appActivity.lastTaskCompletedAt ? new Date(appActivity.lastTaskCompletedAt).getTime() : 0
    );

    if (lastActivity) {
      const expiryTime = lastActivity + cooldownMs;
      if (expiryTime > now && (!nextExpiry || expiryTime < nextExpiry)) {
        nextExpiry = expiryTime;
      }
    }
  }

  return nextExpiry ? nextExpiry - now : null;
}
