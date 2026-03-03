#!/usr/bin/env node
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const profileDir = join(rootDir, 'data', 'browser-profile');

console.log('🌐 Setting up browser directory...');

// Ensure browser profile directory exists
if (!existsSync(profileDir)) {
  mkdirSync(profileDir, { recursive: true });
  console.log('📁 Created browser profile directory');
}

console.log('✅ Browser setup complete');
