/**
 * Give the two long-running FableLoom stages a work-duration timeout.
 *
 * `fableloom-plan-shots` drafts a whole episode's timed-shot plan and
 * `fableloom-weave-episode` weaves a whole episode graph in one LLM call.
 * Observed runs land at 207–300s — right at the toolkit's 5-minute provider
 * default — so a heavier episode is SIGTERM'd mid-generation by the runner's
 * wall clock and the autopilot burns a fallback re-run from scratch (run
 * 284788df, 2026-10-22: exit 143, zero output, identical prompt succeeded at
 * 236s ten minutes earlier). The stageRunner treats `stage.timeout` as the
 * home for "how long the stage's WORK takes" (it beats the provider default
 * and survives provider-pin stripping), so this sets 20 minutes on both
 * stages — the same headroom the importer's whole-manuscript analyze stages
 * use (ANALYZE_STAGE_TIMEOUT_MS).
 *
 * The seed (`data.reference/prompts/stage-config.json`) carries the same
 * values for fresh installs; setup-data's starter merge only adds MISSING
 * stage entries, so existing installs need this migration to pick up the
 * field. A stage the user deleted stays deleted; an existing `timeout` the
 * user set themselves is never overwritten. Idempotent, and a missing file
 * (fresh install before setup-data) is a no-op.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileCore.js';

const STAGE_CONFIG_PATH = join('data', 'prompts', 'stage-config.json');
const STAGE_TIMEOUTS = Object.freeze({
  'fableloom-plan-shots': 1_200_000,
  'fableloom-weave-episode': 1_200_000,
});

export default {
  async up({ rootDir }) {
    const fullPath = join(rootDir, STAGE_CONFIG_PATH);
    const raw = await readFile(fullPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return { stages: 0 };
    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${STAGE_CONFIG_PATH} is not valid JSON (${err.message}) — repair it and re-run migrations`);
    }
    const stages = config?.stages;
    if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return { stages: 0 };

    let changed = 0;
    for (const [stageName, timeout] of Object.entries(STAGE_TIMEOUTS)) {
      const stage = stages[stageName];
      // Absent = the user deleted the stage; a set `timeout` = their own edit.
      if (!stage || typeof stage !== 'object' || stage.timeout != null) continue;
      stage.timeout = timeout;
      changed += 1;
    }
    if (changed) await atomicWrite(fullPath, `${JSON.stringify(config, null, 2)}\n`);
    return { stages: changed };
  },
};
