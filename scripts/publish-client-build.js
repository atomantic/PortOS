/**
 * Build the client away from the served dist directory, then publish it with
 * index.html last. The old index and its content-hashed assets stay usable
 * throughout a build, including when Vite fails after it starts rendering.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectlyInvoked } from './lib/directInvocation.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);
const DEFAULT_CLIENT_DIR = join(ROOT_DIR, 'client');
const STAGE_PREFIX = '.dist-stage-';
const ABANDONED_STAGE_AGE_MS = 24 * 60 * 60 * 1000;

function localReferencePath(reference, stageDir) {
  if (!reference || reference.startsWith('//')) return null;
  let url;
  try {
    url = new URL(reference, 'https://portos.invalid/');
  } catch {
    throw new Error(`Client index contains an invalid asset reference: ${reference}`);
  }
  if (url.origin !== 'https://portos.invalid') return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`Client index contains an invalid encoded asset reference: ${reference}`);
  }
  const candidate = resolve(stageDir, pathname.replace(/^\/+/, ''));
  const withinStage = candidate === stageDir || candidate.startsWith(`${stageDir}${sep}`);
  if (!withinStage) throw new Error(`Client index asset escapes the staged build: ${reference}`);
  return candidate;
}

export function validateStagedBuild(stageDir) {
  const indexPath = join(stageDir, 'index.html');
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error('Client build did not produce index.html');
  }
  const html = readFileSync(indexPath, 'utf8');
  const references = [...html.matchAll(/<(?:script|link|img|source)\b[^>]*>/gi)]
    .flatMap((tag) => [...tag[0].matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)])
    .map((match) => match[1]);
  for (const reference of references) {
    const assetPath = localReferencePath(reference, stageDir);
    if (assetPath && (!existsSync(assetPath) || !statSync(assetPath).isFile())) {
      throw new Error(`Client index references a missing staged asset: ${reference}`);
    }
  }
  return { html, references };
}

export function cleanAbandonedStages(clientDir, now = Date.now()) {
  if (!existsSync(clientDir)) return;
  for (const entry of readdirSync(clientDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGE_PREFIX)) continue;
    const path = join(clientDir, entry.name);
    if (now - statSync(path).mtimeMs >= ABANDONED_STAGE_AGE_MS) rmSync(path, { recursive: true, force: true });
  }
}

function filesEqual(leftPath, rightPath) {
  const leftStat = statSync(leftPath);
  const rightStat = statSync(rightPath);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;

  const left = openSync(leftPath, 'r');
  const right = openSync(rightPath, 'r');
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (position < leftStat.size) {
      const bytes = Math.min(leftBuffer.length, leftStat.size - position);
      const leftRead = readSync(left, leftBuffer, 0, bytes, position);
      const rightRead = readSync(right, rightBuffer, 0, bytes, position);
      if (leftRead === 0 || leftRead !== rightRead || !leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) {
        return false;
      }
      position += leftRead;
    }
    return true;
  } finally {
    closeSync(left);
    closeSync(right);
  }
}

function publishEntry(source, destination) {
  const sourceStat = lstatSync(source);
  if (sourceStat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) publishEntry(join(source, entry), join(destination, entry));
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`Client build produced an unsupported output entry: ${source}`);
  if (existsSync(destination) && lstatSync(destination).isFile() && filesEqual(source, destination)) return;

  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${relative(dirname(destination), destination)}.${process.pid}.${randomUUID()}`);
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function publishStagedBuild(stageDir, distDir, { beforeIndexPublish } = {}) {
  validateStagedBuild(stageDir);
  mkdirSync(distDir, { recursive: true });
  for (const entry of readdirSync(stageDir, { withFileTypes: true })) {
    if (entry.name === 'index.html') continue;
    const source = join(stageDir, entry.name);
    const destination = join(distDir, entry.name);
    publishEntry(source, destination);
  }

  // Revalidate against the served tree after copying. This makes the ordering
  // explicit: every local reference is readable before the new index appears.
  const { references } = validateStagedBuild(stageDir);
  for (const reference of references) {
    const stagedAsset = localReferencePath(reference, stageDir);
    if (!stagedAsset) continue;
    const relativeAsset = relative(stageDir, stagedAsset);
    const publishedAsset = join(distDir, relativeAsset);
    if (!existsSync(publishedAsset) || !statSync(publishedAsset).isFile()) {
      throw new Error(`Client asset was not published before index.html: ${reference}`);
    }
  }

  beforeIndexPublish?.();
  const temporaryIndex = join(distDir, `.index.html.${process.pid}.${randomUUID()}`);
  try {
    copyFileSync(join(stageDir, 'index.html'), temporaryIndex);
    renameSync(temporaryIndex, join(distDir, 'index.html'));
  } finally {
    rmSync(temporaryIndex, { force: true });
  }
}

export async function publishClientBuild({
  clientDir = DEFAULT_CLIENT_DIR,
  distDir = join(clientDir, 'dist'),
  runBuild = runViteBuild,
  beforeIndexPublish,
} = {}) {
  cleanAbandonedStages(clientDir);
  const stageDir = mkdtempSync(join(clientDir, STAGE_PREFIX));
  try {
    await runBuild(stageDir, clientDir);
    publishStagedBuild(stageDir, distDir, { beforeIndexPublish });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

function runViteBuild(stageDir, clientDir) {
  const args = process.argv.slice(2);
  const analyze = args[0] === '--analyze';
  const viteArgs = analyze ? args.slice(1) : args;
  if (viteArgs.some((arg) => arg === '--outDir' || arg.startsWith('--outDir='))) {
    throw new Error('publish-client-build owns Vite --outDir; remove the custom value');
  }
  const viteBin = join(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, 'build', ...viteArgs, '--outDir', stageDir, '--emptyOutDir'], {
    cwd: clientDir,
    env: {
      ...process.env,
      ...(analyze ? { ANALYZE: 'true' } : {}),
      PORTOS_CLIENT_BUILD_OUT_DIR: stageDir,
    },
    stdio: 'inherit',
  });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(signal ? `Vite build terminated by ${signal}` : `Vite build exited with code ${code}`));
    });
  });
}

async function runCli() {
  await publishClientBuild();
  console.log('📦 Published client build to client/dist');
}

if (isDirectlyInvoked(import.meta.url)) {
  runCli().catch((error) => {
    console.error(`❌ Client build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
