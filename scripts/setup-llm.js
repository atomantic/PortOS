#!/usr/bin/env node

/**
 * Local LLM Setup Script
 *
 * Lets the user pick a local-LLM backend (Ollama or LM Studio) and installs
 * the chosen one if it isn't present. The choice is recorded in `.env` as
 * `LLM_BACKEND`; the server enables the matching provider on boot.
 *
 * Idempotent: if `LLM_BACKEND` is already set, this reports status and exits
 * without re-prompting. Non-interactive (CI / piped) runs skip silently.
 *
 * Called by: npm run setup (and `npm run setup:llm` directly).
 */

import { execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');

function parseEnvFile() {
  const result = {};
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { return result; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[trimmed.slice(0, idx).trim()] = value;
  }
  return result;
}

function setBackend(backend) {
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { /* no .env yet */ }
  if (/^LLM_BACKEND=/m.test(content)) {
    content = content.replace(/^LLM_BACKEND=.*/m, `LLM_BACKEND=${backend}`);
  } else {
    content = `LLM_BACKEND=${backend}\n${content}`;
  }
  writeFileSync(envPath, content);
  console.log(`✅ Local LLM backend set to ${backend} (LLM_BACKEND in .env)`);
}

function hasCommand(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; }
}

const hasBrew = () => hasCommand('brew', ['--version']);
const hasOllama = () => hasCommand('ollama', ['--version']);
const hasLmStudio = () =>
  hasCommand('lms', ['version']) ||
  (process.platform === 'darwin' && existsSync('/Applications/LM Studio.app'));

function installOllama() {
  const platform = process.platform;
  try {
    if (platform === 'darwin' && hasBrew()) {
      console.log('🍺 Installing Ollama via Homebrew...');
      execFileSync('brew', ['install', 'ollama'], { stdio: 'inherit' });
      console.log('   Start it with: ollama serve (or `brew services start ollama`)');
      return true;
    }
    if (platform === 'linux') {
      console.log('⬇️  Installing Ollama via official script...');
      execFileSync('bash', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'inherit' });
      return true;
    }
  } catch (err) {
    console.error(`⚠️  Ollama install failed: ${err.message}`);
  }
  console.log('   Download Ollama manually: https://ollama.com/download');
  return false;
}

function installLmStudio() {
  try {
    if (process.platform === 'darwin' && hasBrew()) {
      console.log('🍺 Installing LM Studio via Homebrew...');
      execFileSync('brew', ['install', '--cask', 'lm-studio'], { stdio: 'inherit' });
      console.log('   Launch LM Studio, then enable the local server (Developer tab) and run: lms bootstrap');
      return true;
    }
  } catch (err) {
    console.error(`⚠️  LM Studio install failed: ${err.message}`);
  }
  console.log('   Download LM Studio manually: https://lmstudio.ai/download');
  return false;
}

function promptChoice() {
  return new Promise((resolve) => {
    console.log('🧠 Choose a local LLM backend (for free, on-device models):');
    console.log('');
    console.log('   1) Ollama    (CLI-first, simple `ollama pull`, great default)');
    console.log('   2) LM Studio (GUI app with a built-in model browser)');
    console.log('   3) Skip      (configure later in Settings → Local LLMs)');
    console.log('');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Enter choice [1/2/3]: ', (answer) => {
      rl.close();
      const t = answer.trim();
      resolve(t === '1' ? 'ollama' : t === '2' ? 'lmstudio' : 'skip');
    });
  });
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`   ${question} [y/N]: `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const env = parseEnvFile();
const existing = env.LLM_BACKEND || process.env.LLM_BACKEND;

if (existing === 'ollama' || existing === 'lmstudio') {
  const installed = existing === 'ollama' ? hasOllama() : hasLmStudio();
  console.log(`🧠 Local LLM backend: ${existing}${installed ? ' (installed)' : ' — not detected, install it to use local models'}`);
  process.exit(0);
}

// Non-interactive: don't block setup / CI. Leave LLM_BACKEND unset.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log('🧠 No local LLM backend selected — set one later in Settings → Local LLMs (or `npm run setup:llm`).');
  process.exit(0);
}

const choice = await promptChoice();

if (choice === 'skip') {
  console.log('   Skipped — pick a backend later in Settings → Local LLMs.');
  process.exit(0);
}

const alreadyInstalled = choice === 'ollama' ? hasOllama() : hasLmStudio();
if (!alreadyInstalled) {
  const label = choice === 'ollama' ? 'Ollama' : 'LM Studio';
  const yes = await promptYesNo(`${label} is not installed. Install it now?`);
  if (yes) {
    (choice === 'ollama' ? installOllama : installLmStudio)();
  } else {
    console.log(`   Skipping install — you can install ${label} later, the choice is still saved.`);
  }
}

setBackend(choice);
