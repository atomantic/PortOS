/**
 * Hosted (linux/amd64) acquisition of the pinned actionlint, driven by the
 * pins in scripts/lib/actionlint.js so one edit updates CI and the local probe.
 * The archive's SHA-256 is verified before anything is extracted.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ACTIONLINT_SHA256_LINUX_AMD64, ACTIONLINT_VERSION } from './lib/actionlint.js';

export function archiveName(version = ACTIONLINT_VERSION) {
  return `actionlint_${version}_linux_amd64.tar.gz`;
}

export function archiveUrl(version = ACTIONLINT_VERSION) {
  return `https://github.com/rhysd/actionlint/releases/download/v${version}/${archiveName(version)}`;
}

export function verifySha256(bytes, expected = ACTIONLINT_SHA256_LINUX_AMD64) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`actionlint archive checksum mismatch: expected ${expected}, got ${actual}`);
}

async function defaultFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function defaultExtract(archivePath, binDir) {
  const r = spawnSync('tar', ['-xzf', archivePath, '-C', binDir, 'actionlint'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar extraction failed');
}

/** Download, verify, then extract. Throws before extraction on a bad checksum. */
export async function installActionlint({ dir, fetchArchive = defaultFetch, extract = defaultExtract } = {}) {
  const binDir = join(dir, 'actionlint-bin');
  mkdirSync(binDir, { recursive: true });
  const bytes = await fetchArchive(archiveUrl());
  verifySha256(bytes);
  const archivePath = join(dir, archiveName());
  writeFileSync(archivePath, bytes);
  extract(archivePath, binDir);
  return binDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp';
  const binDir = await installActionlint({ dir });
  if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${binDir}\n`);
  console.log(`✅ actionlint ${ACTIONLINT_VERSION} installed to ${binDir}`);
}
