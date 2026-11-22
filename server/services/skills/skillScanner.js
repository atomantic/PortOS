/**
 * Scan-time security quarantine for untrusted (`project`, `external`) skills.
 *
 * Every text file of a skill (`SKILL.md` plus its references/templates/scripts/
 * examples) runs through the deterministic model-abuse signals PortOS already
 * applies to external content (`lib/modelAbuseGuard.js`): invisible or
 * direction-control Unicode, hidden-markup instructions, instruction override,
 * context/credential disclosure, secret exfiltration, encoded instructions and
 * download-and-execute. Any finding is a `dangerous` verdict and the service
 * keeps that skill out of the index, listing and loading. Findings carry the
 * guard's generic reasons and never quote the skill, so displaying one cannot
 * become another injection channel. No model is called.
 *
 * Storage: `ephemeral-file` (`data/cache/skill-scans.json`) — machine-local,
 * never federated, regenerable. Verdicts are keyed by a SHA-256 over the
 * scanner version and every scanned file's path and bytes, so any edit (a
 * `git pull` in a project repo included) changes the key and forces a rescan;
 * a lost or corrupt cache only costs a rescan.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { detectDeterministicModelAbuseSignals } from '../../lib/modelAbuseGuard.js';
import { atomicWrite, PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { listSkillSupportFiles, SKILL_FILE, SKILL_LIMITS } from '../../lib/skills/skillRegistry.js';

// Bump when the rule set changes meaning so cached verdicts are re-derived.
export const SKILL_SCANNER_VERSION = 1;
const MAX_CACHE_ENTRIES = 1000;

const cachePath = () => join(PATHS.data, 'cache', 'skill-scans.json');

let cache = null;
let writeTail = Promise.resolve();

const loadCache = async () => {
  if (cache) return cache;
  const stored = await readJSONFile(cachePath(), null, { logError: false });
  cache = new Map(stored?.version === SKILL_SCANNER_VERSION && stored.entries && typeof stored.entries === 'object'
    ? Object.entries(stored.entries) : []);
  return cache;
};

const persistCache = () => {
  writeTail = writeTail.then(async () => {
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    await atomicWrite(cachePath(), { version: SKILL_SCANNER_VERSION, entries: Object.fromEntries(cache) });
  }).catch((error) => console.log(`⚠️ Skill scan cache write skipped: ${error.message}`));
  return writeTail;
};

/** Read every scannable file of a skill. Binary or oversized files are hashed by size but not scanned (Level 2 refuses to serve them). */
async function collectSkillFiles(skillDir) {
  const { files: support } = await listSkillSupportFiles(skillDir);
  const entries = [SKILL_FILE, ...support.map((file) => file.path)];
  const collected = [];
  for (const path of entries) {
    const buffer = await readFile(join(skillDir, ...path.split('/'))).catch(() => null);
    if (!buffer) continue;
    const scannable = buffer.length <= SKILL_LIMITS.MAX_SUPPORT_FILE_BYTES && !buffer.includes(0);
    collected.push({ path, buffer, content: scannable ? buffer.toString('utf8') : null });
  }
  return collected;
}

const hashFiles = (files) => {
  const hash = createHash('sha256').update(`skill-scan:v${SKILL_SCANNER_VERSION}\0`);
  for (const file of files) hash.update(`${file.path}\0${file.buffer.length}\0`).update(file.buffer).update('\0');
  return hash.digest('hex');
};

/** Pure verdict over already-read files: `dangerous` on any deterministic finding. */
export function scanSkillFiles(files) {
  const findings = [];
  for (const file of files) {
    if (file.content === null) continue;
    for (const finding of detectDeterministicModelAbuseSignals(file.content)) {
      findings.push({ file: file.path, category: finding.category, reason: finding.reason });
    }
  }
  return { verdict: findings.length ? 'dangerous' : 'clean', findings };
}

/**
 * Scan one skill directory, reusing a cached verdict when its content hash is
 * unchanged.
 *
 * @returns {Promise<{ verdict: 'clean'|'dangerous', findings: object[], hash: string, cached: boolean }>}
 */
export async function scanSkill(skill) {
  const files = await collectSkillFiles(skill.dir);
  const hash = hashFiles(files);
  const entries = await loadCache();
  const hit = entries.get(hash);
  if (hit) return { ...hit, hash, cached: true };
  const result = scanSkillFiles(files);
  entries.set(hash, { verdict: result.verdict, findings: result.findings, scannedAt: new Date().toISOString() });
  await persistCache();
  if (result.verdict === 'dangerous') {
    console.log(`🛡️ Skill ${skill.id} quarantined: ${[...new Set(result.findings.map((finding) => finding.category))].join(', ')}`);
  }
  return { ...result, hash, cached: false };
}

/** Drop the in-memory cache so the next scan re-reads the file (tests, or after an external cache edit). */
export function resetSkillScanCache() {
  cache = null;
}
