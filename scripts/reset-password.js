#!/usr/bin/env node
/**
 * CLI recovery path for a lost/broken PortOS instance password (the web UI's
 * own password change requires the CURRENT password, so it cannot help here).
 * Writes `secrets.auth` in `data/settings.json` directly — the same shape
 * `server/services/auth.js` `setPassword`/`clearPassword` produce — using the
 * same scrypt primitives from `lib/portosAuthCore.js` so the result is
 * byte-compatible with a normal in-app password change. Bypasses the
 * current-password check on purpose: this tool exists for the case where that
 * check can no longer be satisfied. Filesystem access to the install already
 * implies the same trust level as the running server process (see AGENTS.md
 * "Security Model").
 *
 * All existing sessions are revoked, matching setPassword/clearPassword's
 * behavior. The running server caches settings.json in memory and only
 * refreshes it on an in-app write, so it must be RESTARTED after this runs.
 *
 * Usage:
 *   node scripts/reset-password.js <newPassword>   # set/replace the password
 *   node scripts/reset-password.js --disable       # turn the password gate off
 *   node scripts/reset-password.js --status        # report enabled/disabled only
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { hashPassword, SALT_BYTES } from '../lib/portosAuthCore.js';
import { atomicWrite, safeJSONParse, tryReadFile, PATHS } from '../server/lib/fileUtils.js';
import { isPlainObject } from '../server/lib/objects.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

export const USAGE = [
  'Usage:',
  '  node scripts/reset-password.js <newPassword>   # set/replace the password',
  '  node scripts/reset-password.js --disable       # turn the password gate off',
  '  node scripts/reset-password.js --status        # report enabled/disabled only',
].join('\n');

export const isPasswordAuthEnabled = (settings) => {
  const auth = settings?.secrets?.auth;
  return !!(auth?.enabled && auth?.passwordHash && auth?.salt);
};

// Pure: builds the next settings object for `--disable`, or `null` when auth
// was already off (nothing to write).
export const buildDisabledSettings = (settings) => {
  if (!settings?.secrets?.auth) return null;
  const secrets = { ...settings.secrets };
  delete secrets.auth;
  return { ...settings, secrets, passwordRiskRevision: randomBytes(16).toString('hex') };
};

// Validates the candidate password (mirrors setPassword's bounds) and builds
// the next settings object with a freshly-hashed `secrets.auth` record.
export const buildPasswordSettings = async (settings, newPassword) => {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (newPassword.length > 256) {
    throw new Error('Password too long (max 256 characters).');
  }
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const passwordHash = await hashPassword(newPassword, salt);
  const secrets = { ...(settings.secrets || {}) };
  secrets.auth = {
    enabled: true,
    kdf: 'scrypt',
    passwordHash,
    salt,
    updatedAt: new Date().toISOString(),
  };
  return { ...settings, secrets, passwordRiskRevision: randomBytes(16).toString('hex') };
};

const loadSettings = async (settingsFile) => {
  const raw = await tryReadFile(settingsFile);
  const parsed = safeJSONParse(raw ?? '{}', {});
  return isPlainObject(parsed) ? parsed : {};
};

const writeJSON = async (filePath, value) => {
  await atomicWrite(filePath, JSON.stringify(value, null, 2) + '\n');
};

/**
 * Runs one reset-password action against the given data directory and
 * returns `{ code, message }` for the caller to print/exit with — kept
 * separate from `main()` so tests can point it at a temp directory instead of
 * the real install's `data/`.
 */
export const runResetPassword = async (arg, { dataDir = PATHS.data } = {}) => {
  if (!arg || arg === '--help' || arg === '-h') {
    return { code: arg ? 0 : 1, message: USAGE };
  }

  const settingsFile = join(dataDir, 'settings.json');
  const settings = await loadSettings(settingsFile);

  if (arg === '--status') {
    return {
      code: 0,
      message: isPasswordAuthEnabled(settings) ? '🔒 Password auth is enabled.' : '🔓 Password auth is disabled.',
    };
  }

  const sessionsFile = join(dataDir, 'auth-sessions.json');
  const restartReminder = '⚠️  Restart PortOS for this to take effect (it caches settings.json in memory):\n   npm run pm2:restart';

  if (arg === '--disable') {
    const next = buildDisabledSettings(settings);
    if (!next) return { code: 0, message: '🔓 Password auth is already disabled — nothing to do.' };
    await writeJSON(settingsFile, next);
    await writeJSON(sessionsFile, { tokens: [] });
    return { code: 0, message: `✅ Password auth disabled and all sessions revoked.\n${restartReminder}` };
  }

  let next;
  try {
    next = await buildPasswordSettings(settings, arg);
  } catch (err) {
    return { code: 1, message: `❌ ${err.message}` };
  }
  await writeJSON(settingsFile, next);
  await writeJSON(sessionsFile, { tokens: [] });
  return { code: 0, message: `✅ Password reset and all sessions revoked.\n${restartReminder}` };
};

const main = async () => {
  const [arg] = process.argv.slice(2);
  const { code, message } = await runResetPassword(arg);
  if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
};

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ Password reset failed: ${err.message}`);
    process.exit(1);
  });
}
