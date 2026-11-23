/**
 * Cached `env` block of the host user's `~/.claude/settings.json`, injected into Claude CLI spawns.
 *
 * Carries the user's Bedrock/provider config (CLAUDE_CODE_USE_BEDROCK,
 * AWS_PROFILE, etc.) into spawned agents even when PM2 started without it.
 */
import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';

let _claudeSettingsEnvCache = null;
let _claudeSettingsEnvCacheTime = 0;
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getClaudeSettingsEnv() {
  if (_claudeSettingsEnvCache !== null && (Date.now() - _claudeSettingsEnvCacheTime) < SETTINGS_CACHE_TTL_MS) return _claudeSettingsEnvCache;
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      _claudeSettingsEnvCache = settings.env || {};
    } else {
      _claudeSettingsEnvCache = {};
    }
  } catch (err) {
    console.warn(`⚠️ Failed to read claude settings: ${err.message}`);
    _claudeSettingsEnvCache = {};
  }
  _claudeSettingsEnvCacheTime = Date.now();
  return _claudeSettingsEnvCache;
}
