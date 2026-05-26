#!/usr/bin/env node

/**
 * Browser Setup Script
 *
 * Ensures the browser profile dir exists, and (interactively, first run only)
 * offers to use Chrome Canary as the PortOS-managed browser. Differentiating
 * PortOS's CDP browser from the user's daily-driver Chrome avoids profile
 * collisions and TCC ambiguity, and the Canary update cadence keeps the
 * automation surface fresh.
 *
 * Idempotent: if `data/browser-config.json` already has `chromePath` set, this
 * exits without re-prompting. Non-interactive (CI / pm2-managed update.sh)
 * runs skip silently. `PORTOS_USE_CANARY=1` opts in without prompting; `=0`
 * opts out without prompting.
 *
 * Called by: npm run setup, setup.sh/ps1, update.sh/ps1.
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const profileDir = join(dataDir, 'browser-profile');
const configFile = join(dataDir, 'browser-config.json');

console.log('🌐 Ensuring browser profile directory exists...');
if (!existsSync(profileDir)) {
  mkdirSync(profileDir, { recursive: true });
  console.log('📁 Created browser profile directory');
}

// Returns {} when the file is absent, the parsed object when readable, or null
// when it exists but is corrupt — so callers can avoid overwriting (and wiping
// the user's other keys: cdpPort, userDataDir, etc.) on a transient corruption.
function loadConfig() {
  if (!existsSync(configFile)) return {};
  try {
    return JSON.parse(readFileSync(configFile, 'utf-8'));
  } catch (err) {
    console.warn(`⚠️  browser-config.json is unreadable (${err.message}); leaving it untouched.`);
    return null;
  }
}

function saveConfig(config) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2));
}

function hasCommand(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; }
}

// macOS Canary lives at the conventional `.app` bundle. Windows Canary installs
// to LOCALAPPDATA (per-user). Linux has no Canary build — we no-op there.
function detectCanary() {
  const os = platform();
  if (os === 'darwin') {
    const app = '/Applications/Google Chrome Canary.app';
    const bin = `${app}/Contents/MacOS/Google Chrome Canary`;
    return existsSync(bin) ? { app, bin } : null;
  }
  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const bin = join(localAppData, 'Google', 'Chrome SxS', 'Application', 'chrome.exe');
    return existsSync(bin) ? { bin } : null;
  }
  return null;
}

function canaryInstallCommand() {
  const os = platform();
  if (os === 'darwin' && hasCommand('brew', ['--version'])) {
    return { cmd: 'brew', args: ['install', '--cask', 'google-chrome@canary'], label: 'Homebrew' };
  }
  if (os === 'win32' && hasCommand('winget', ['--version'])) {
    return { cmd: 'winget', args: ['install', '--id', 'Google.Chrome.Canary', '-e', '--source', 'winget'], label: 'winget' };
  }
  return null;
}

function applyCanaryToConfig(found) {
  const config = loadConfig();
  if (config === null) {
    console.warn('   Skipping Canary config write — fix the corrupt browser-config.json first.');
    return;
  }
  config.chromePath = found.bin;
  if (found.app) config.macAppBundle = found.app;
  saveConfig(config);
  console.log(`✅ PortOS browser set to Chrome Canary → ${found.bin}`);
}

function promptYesNo(question, defaultYes = true) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`   ${question} ${suffix}: `, (answer) => {
      rl.close();
      const t = (answer || '').trim();
      if (!t) return resolve(defaultYes);
      resolve(/^y(es)?$/i.test(t));
    });
  });
}

async function runCanarySetup() {
  const os = platform();
  if (os !== 'darwin' && os !== 'win32') {
    // Linux: no Canary build. Skip silently — the field is still
    // editable from Settings → Browser if the user wants Chromium/Brave.
    return;
  }

  const config = loadConfig();
  if (typeof config?.chromePath === 'string' && config.chromePath.trim()) {
    // Already configured — don't re-prompt on subsequent setup/update runs.
    return;
  }

  const envOptOut = process.env.PORTOS_USE_CANARY === '0' || process.env.PORTOS_USE_CANARY === 'false';
  const envOptIn = process.env.PORTOS_USE_CANARY === '1' || process.env.PORTOS_USE_CANARY === 'true';
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (envOptOut) return;
  if (!interactive && !envOptIn) {
    // Non-TTY (CI, update.sh under pm2) and no explicit opt-in: print a
    // one-liner hint and bail. The user can re-run setup interactively or
    // toggle from Settings → Browser.
    console.log('💡 Tip: PortOS can use Chrome Canary as its managed browser (run setup interactively or set PORTOS_USE_CANARY=1).');
    return;
  }

  const found = detectCanary();

  if (found) {
    const ok = envOptIn ? true : await promptYesNo('Chrome Canary detected. Use it as the PortOS-managed browser?', true);
    if (ok) applyCanaryToConfig(found);
    else console.log('   Keeping the platform-default Chrome. You can switch later in Settings → Browser.');
    return;
  }

  const install = canaryInstallCommand();
  if (!install) {
    const downloadUrl = 'https://www.google.com/chrome/canary/';
    console.log(`💡 Chrome Canary not detected, and no package manager available to install it. Download manually: ${downloadUrl}`);
    return;
  }

  const ok = envOptIn ? true : await promptYesNo(`Install Chrome Canary via ${install.label} and use it as the PortOS-managed browser?`, true);
  if (!ok) {
    console.log('   Keeping the platform-default Chrome. You can switch later in Settings → Browser.');
    return;
  }

  console.log(`🍺 Installing Chrome Canary via ${install.label}...`);
  const result = spawnSync(install.cmd, install.args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.log(`⚠️  ${install.label} install of Chrome Canary failed (exit ${result.status}). You can install it manually and re-run setup.`);
    return;
  }

  const reFound = detectCanary();
  if (reFound) applyCanaryToConfig(reFound);
  else console.log('⚠️  Canary installed but the binary was not found at the expected path. You can set chromePath manually in Settings → Browser.');
}

// A throw here (EACCES writing the config, install subprocess failure, etc.)
// must not abort the larger `npm run setup` / update.sh step it's chained into.
await runCanarySetup().catch((err) => console.warn(`⚠️  Browser Canary setup skipped: ${err.message}`));

console.log('✅ Browser setup complete');
