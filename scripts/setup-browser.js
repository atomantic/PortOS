#!/usr/bin/env node
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserDir = join(__dirname, '..', 'browser');

console.log('🌐 Setting up browser directory...');

if (!existsSync(join(browserDir, 'node_modules'))) {
  console.log('📦 Installing browser dependencies...');
  execSync('npm install', { cwd: browserDir, stdio: 'inherit' });

  console.log('🎭 Installing Playwright browsers...');
  execSync('npx playwright install chromium', { cwd: browserDir, stdio: 'inherit' });

  console.log('✅ Browser setup complete');
} else {
  console.log('✅ Browser dependencies already installed, skipping setup');
}
