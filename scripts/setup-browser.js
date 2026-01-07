#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const browserDir = join(rootDir, '.browser');
const templateDir = join(rootDir, '.browser.template');

console.log('🌐 Setting up .browser directory...');

if (!existsSync(browserDir)) {
  console.log('📁 Creating .browser directory from template...');
  mkdirSync(browserDir, { recursive: true });
  cpSync(templateDir, browserDir, { recursive: true });

  console.log('📦 Installing browser dependencies...');
  execSync('npm install', { cwd: browserDir, stdio: 'inherit' });

  console.log('🎭 Installing Playwright browsers...');
  execSync('npx playwright install chromium', { cwd: browserDir, stdio: 'inherit' });

  console.log('✅ .browser directory setup complete');
} else {
  console.log('✅ .browser directory already exists, skipping setup');
}
