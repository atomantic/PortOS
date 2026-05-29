/**
 * Flip the persisted `reference-watch` `taskMetadata.readOnly` from `true` to
 * `false` on existing installs.
 *
 * Background: prior versions of PortOS shipped `DEFAULT_TASK_INTERVALS['reference-watch']`
 * with `taskMetadata: { readOnly: true }`. That value got persisted into
 * `data/task-schedule.json` on every load through `loadSchedule`'s deep-merge
 * + `saveSchedule` path. The v2 reference-watch prompt
 * (`PROMPT_VERSIONS['reference-watch'] = 2`) instructs the agent to APPEND
 * slug-tagged `[ref-watch-…]` checklist items to PLAN.md and commit them — but
 * `readOnly: true` causes `agentPromptBuilder.js` to inject a "do not modify
 * or commit files" guard into the system prompt, so the agent (correctly)
 * refuses to write anything. The weekly cron silently no-oped.
 *
 * The default has been flipped to `readOnly: false` in this release, but
 * `loadSchedule`'s taskMetadata deep-merge (server/services/taskSchedule.js:2521)
 * spreads the STORED metadata *over* the new default — so any install that
 * previously persisted `readOnly: true` retains the broken stored value and
 * the cron stays no-op even after the default flip.
 *
 * This migration patches `data/task-schedule.json`: when
 * `tasks['reference-watch'].taskMetadata.readOnly === true`, flip it to
 * `false`. A user who deliberately set it to a different value (string,
 * object, etc.) is left alone — we only rewrite the exact stale boolean the
 * old default would have written. Fresh installs are unaffected (file absent
 * → migration no-ops).
 *
 * Idempotent: a second run sees `readOnly: false` (or no entry) and exits
 * without writing.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const REL_PATH = 'data/task-schedule.json';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${REL_PATH} not present — skipping (fresh install)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    const task = config?.tasks?.['reference-watch'];
    if (!task || typeof task !== 'object') {
      console.log(`✅ ${REL_PATH}: no stored 'reference-watch' task — nothing to migrate`);
      return;
    }

    const meta = task.taskMetadata;
    if (!meta || typeof meta !== 'object') {
      console.log(`✅ ${REL_PATH}: 'reference-watch' has no stored taskMetadata — nothing to migrate`);
      return;
    }

    if (meta.readOnly !== true) {
      console.log(`✅ ${REL_PATH}: 'reference-watch' taskMetadata.readOnly already not-true, no changes`);
      return;
    }

    meta.readOnly = false;
    await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${REL_PATH}: flipped 'reference-watch' taskMetadata.readOnly true → false (v2 prompt needs write access to PLAN.md)`);
  },
};
