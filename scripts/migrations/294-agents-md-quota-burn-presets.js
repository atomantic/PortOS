/**
 * Rewrite stored quota-burn audit prompts that still name CLAUDE.md (#4852).
 *
 * Picking a preset COPIES its text into the job's own `params.prompt`, and that
 * snapshot carries no version marker — so unlike the scheduled-task prompts
 * there is no auto-upgrade-on-read path to lean on. This migration supplies the
 * missing safe-upgrade step under the same rule promptMatchesShippedDefault uses:
 * a stored prompt is rewritten ONLY when it is byte-for-byte the prior
 * unmodified render of a shipped preset. Anything the user edited — even by one
 * character — is left exactly as it is.
 *
 * The prior render is DERIVED from the current preset by reversing the one
 * wording change, rather than pasted in as ten frozen blobs: the derivation
 * cannot drift out of sync with the presets, and it keeps the migration short.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { QUOTA_BURN_PROMPT_PRESETS } from '../../server/lib/quotaBurnPresets.js';

const QUOTA_BURN_PATH = join('data', 'cos', 'quota-burn.json');

// The exact before/after of the #4852 wording change in `auditContract`.
const CURRENT_FRAGMENT = `Read this repository's \`AGENTS.md\` (or \`CLAUDE.md\`, and any nested
per-directory ones covering the slice) before you start, and honor its
conventions and its explicitly declared non-issues — a finding that contradicts
a documented project decision is noise, not a bug.`;

const PRIOR_FRAGMENT = `Read this repository's \`CLAUDE.md\` (and any nested per-directory ones covering
the slice) before you start, and honor its conventions and its explicitly
declared non-issues — a finding that contradicts a documented project decision
is noise, not a bug.`;

/** prior unmodified render → current render, for every shipped audit preset. */
function buildUpgradeMap() {
  const map = new Map();
  for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
    const current = preset.params?.prompt;
    if (typeof current !== 'string' || !current.includes(CURRENT_FRAGMENT)) continue;
    map.set(current.split(CURRENT_FRAGMENT).join(PRIOR_FRAGMENT), current);
  }
  return map;
}

async function readJson(path) {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default {
  async up({ rootDir }) {
    const fullPath = join(rootDir, QUOTA_BURN_PATH);
    const config = await readJson(fullPath);
    if (!config?.families) return { updated: 0 };

    const upgrades = buildUpgradeMap();
    let updatedCount = 0;
    let skippedCustom = 0;

    for (const [familyId, family] of Object.entries(config.families)) {
      for (const job of family?.jobs || []) {
        const stored = job?.params?.prompt;
        if (typeof stored !== 'string' || !stored.includes('CLAUDE.md')) continue;
        const upgraded = upgrades.get(stored);
        if (!upgraded) {
          skippedCustom += 1;
          continue;
        }
        job.params.prompt = upgraded;
        updatedCount += 1;
        console.log(`📝 ${QUOTA_BURN_PATH}: upgraded ${familyId}/${job.id || 'job'} audit prompt to the AGENTS.md wording`);
      }
    }

    if (updatedCount) await writeFile(fullPath, `${JSON.stringify(config, null, 2)}\n`);
    if (skippedCustom) console.log(`✋ ${QUOTA_BURN_PATH}: left ${skippedCustom} user-edited prompt(s) untouched`);
    return { updated: updatedCount, skipped: skippedCustom };
  },
};
