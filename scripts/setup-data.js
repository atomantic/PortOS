#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const sampleDir = join(rootDir, 'data.sample');

console.log('📁 Setting up data directory...');

if (!existsSync(dataDir)) {
  console.log('📁 Creating data directory from data.sample...');
  mkdirSync(dataDir, { recursive: true });
  cpSync(sampleDir, dataDir, { recursive: true });

  // Replace __PORTOS_ROOT__ placeholder with actual install path in apps.json
  const appsFile = join(dataDir, 'apps.json');
  if (existsSync(appsFile)) {
    const content = readFileSync(appsFile, 'utf8');
    if (content.includes('__PORTOS_ROOT__')) {
      writeFileSync(appsFile, content.replace(/__PORTOS_ROOT__/g, rootDir));
      console.log(`📍 Set PortOS repoPath to ${rootDir}`);
    }
  }

  console.log('✅ Data directory created');
} else {
  // Ensure all subdirectories exist without overwriting existing files
  const ensureSubdirs = (srcDir, destDir) => {
    const items = readdirSync(srcDir);
    for (const item of items) {
      const srcPath = join(srcDir, item);
      const destPath = join(destDir, item);
      const stat = statSync(srcPath);

      if (stat.isDirectory()) {
        if (!existsSync(destPath)) {
          console.log(`📁 Creating missing directory: ${item}`);
          mkdirSync(destPath, { recursive: true });
        }
        ensureSubdirs(srcPath, destPath);
      }
    }
  };

  ensureSubdirs(sampleDir, dataDir);
  console.log('✅ Data directory already exists, ensured subdirectories');
}
